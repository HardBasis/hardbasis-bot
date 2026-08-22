#!/usr/bin/env -S npx tsx
/**
 * hardbasis-bot — reference API client + continuous soak.
 *
 * Composition root. Phases: guard (off-testnet refusal) → self-bootstrap →
 * open the socket → full endpoint coverage + error-code probes → the trading
 * loop with the dead-man's-switch drill, a reconnect drill, and a periodic
 * withdrawal check → summaries. `--once` runs a single full pass and exits
 * (the smoke); default runs unattended forever.
 */
import { loadConfig } from "./config.ts";
import { Logger } from "./logger.ts";
import { HttpClient } from "./http.ts";
import { Api } from "./api.ts";
import { assertTestnet, RefusedToTrade } from "./guard.ts";
import { Store } from "./state.ts";
import { ensureBootstrapped } from "./bootstrap.ts";
import { Strategy } from "./strategy.ts";
import { Coverage } from "./coverage.ts";
import { runErrorProbes, probeRateLimit } from "./errorprobe.ts";
import { withdrawalCheck } from "./withdrawal.ts";
import { exerciseConfirmationFlow } from "./confirm.ts";
import { WsClient } from "./ws.ts";
import { emitSummary } from "./summary.ts";
import { firstNonMonotonic, dedupAcrossReconnect } from "./invariants.ts";
import { claimSlot, renewSlot, slotStateDir } from "./instance.ts";
import { deriveProfile, type Profile } from "./decorrelate.ts";
import { Q9 } from "./money.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger({
    logDir: cfg.logDir,
    maxBytes: cfg.logMaxBytes,
    maxFiles: cfg.logMaxFiles,
    base: { instance: cfg.instanceId, role: cfg.role },
    ...(cfg.alertWebhookUrl ? { alertWebhookUrl: cfg.alertWebhookUrl } : {}),
    ...(cfg.alertNtfyUrl ? { alertNtfyUrl: cfg.alertNtfyUrl } : {}),
  });
  log.info("hardbasis-bot starting", { baseUrl: cfg.baseUrl, once: cfg.once, role: cfg.role, instance: cfg.instanceId });

  // Traders claim a decorrelation slot from the shared volume — an atomic
  // ordinal that seeds a distinct stance/phase/period/size and a signup stagger,
  // so `--scale trader=N` is N cooperating bots, not N identical ones.
  let profile: Profile | undefined;
  let slotForRenew: number | null = null;
  let staggerMs = 0;
  if (cfg.role === "trader") {
    const claim = claimSlot(cfg.slotsDir, cfg.maxSlots, cfg.instanceId);
    if (claim.exhausted) {
      log.warn("all decorrelation slots taken; running with the fallback profile", { maxSlots: cfg.maxSlots });
    }
    // State follows the SLOT, not the container: a recreate takes over a stale
    // lease and inherits that slot's account instead of bootstrapping a new one.
    if (!claim.exhausted) {
      cfg.stateDir = slotStateDir(cfg.baseStateDir, claim.slot);
      slotForRenew = claim.slot;
      log.info("claimed decorrelation slot", {
        slot: claim.slot,
        tookOver: claim.tookOver,
        stateDir: cfg.stateDir,
      });
    }
    profile = deriveProfile(
      claim.slot,
      { periodMs: cfg.signalPeriodMs, orderContracts: cfg.orderContracts, bandQ9: cfg.oscBandQ9, staggerStepMs: cfg.signupStaggerMs, jitterPct: cfg.jitterPct },
      {
        ...(cfg.stanceOverride ? { stance: cfg.stanceOverride } : {}),
        ...(cfg.phaseOffsetMs !== undefined ? { phaseFracQ9: phaseFrac(cfg.phaseOffsetMs, cfg.signalPeriodMs) } : {}),
      },
    );
    staggerMs = profile.staggerMs;
    log.info("decorrelated trader profile", {
      slot: profile.slot,
      stance: profile.stance,
      periodMs: profile.periodMs.toString(),
      phaseFracQ9: profile.phaseFracQ9.toString(),
      orderContracts: profile.orderContracts.toString(),
      staggerMs: profile.staggerMs,
    });
  }

  // Deliberate alert self-test (HB_ALERT_SELFTEST=1): fire ONE ALERT at startup
  // so an operator can prove invariant-violation alerts escape the box before
  // trusting them for days. Fires through the same webhook/ntfy path a real
  // finding uses; a no-op unless an alert sink is configured.
  if (cfg.alertSelfTest) {
    log.alert("hardbasis-bot: startup alert self-test — if you received this, invariant-violation alerts will escape the box");
  }

  const http = new HttpClient(cfg.baseUrl, log);
  const api = new Api(http);

  // Phase 1 — off-testnet refusal.
  let deployment: string;
  try {
    deployment = await assertTestnet(http, cfg.allowNonTestnet);
  } catch (e) {
    if (e instanceof RefusedToTrade) {
      log.error("refusing to trade", { reason: e.message });
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  log.info("deployment verified", { deployment });

  // Phase 2 — self-bootstrap (staggered for traders so a scaled fleet does not
  // sign up in unison and trip the per-IP signup throttle).
  const store = new Store(cfg.stateDir);
  const state = await ensureBootstrapped(api, store, cfg, log, deployment, Date.now, staggerMs);

  // Phase 3 — strategy + socket.
  const strategy = new Strategy(api, cfg, state, store, log, Date.now, cfg.role, profile);
  await strategy.init();

  const accountSeqs: bigint[] = [];
  const ws = new WsClient(cfg.wsUrl, log, {
    onPrice: (_feed, mid) => {
      if (mid !== null) strategy.onMid(mid);
    },
    onAccount: (seq) => {
      if (seq !== null) {
        accountSeqs.push(seq);
        const bad = firstNonMonotonic(accountSeqs.slice(-64));
        if (bad) {
          log.finding({
            kind: "invariant:sequencing",
            summary: `account seq not monotonic: ${bad.prev} then ${bad.cur}`,
            evidence: bad,
          });
        }
      }
    },
    onStats: (marketId, frame) => log.debug("stats frame", { marketId, keys: Object.keys(frame) }),
    onProtocol: (v) => log.info("ws protocol version", { v }),
    onError: (frame) => log.warn("ws error frame", { frame }),
  });
  ws.auth(state.tradeKey, false); // account channel needs read scope (trade key has it)
  ws.connect();
  ws.subscribe("prices", { feedId: strategy.feedId() });
  ws.subscribe("stats", { marketId: strategy.marketId() });
  ws.subscribe("account");

  // Wait briefly for the first oracle mid. The auditor's signal needs it; a
  // trader's oscillator does not, but the frame proves the socket is live.
  await waitFor(() => ws.lastMidQ8 !== null, 20_000).catch(() => log.warn("no oracle mid within 20s; continuing"));

  // A trader is trade + WebSocket only: NO coverage sweep, NO error probes, NO
  // deadman/reconnect/rate-limit drills, NO confirmation/withdrawal exercise.
  // Those are auditor duties; N traders re-running them would burn one shared
  // per-IP budget on redundant sweeps. A trader arms its dead-man's-switch (a
  // safety, not an assertion), warms up, and enters the loop.
  if (cfg.role === "trader") {
    await strategy.armDeadman();
    await runTicks(strategy, log, cfg.tickMs, cfg.once ? 4 : 3);
    emitSummary(http, log, 0n, { phase: "startup-complete", role: "trader", accountSeqsSeen: accountSeqs.length });
    if (cfg.once) {
      log.info("trader smoke pass complete; shutting down", { findings: log.findings.length });
      ws.close();
      await new Promise((r) => setTimeout(r, 500));
      return;
    }
    runLoopForever(strategy, api, state, store, http, log, cfg, ws, slotForRenew);
    return;
  }

  // ── Auditor (the single reference instance): full coverage + all probes ──

  // Phase 4 — coverage + error probes (once).
  const coverage = new Coverage(api, state, log);
  const report = await coverage.sweep();
  log.info("coverage sweep complete", { touched: report.touched.length, cursorPages: report.cursorPages });
  const mkt = await api.market(strategy.marketId());
  const tick = /^\d+$/.test(mkt.body?.tickSizeQ8 ?? "") ? BigInt(mkt.body.tickSizeQ8) : 1n;
  const mid = ws.lastMidQ8 ?? (/^\d+$/.test(mkt.body?.lastPrice?.midQ8 ?? "") ? BigInt(mkt.body.lastPrice!.midQ8) : 10_000_000_000n);
  const probes = await runErrorProbes(api, state, log, strategy.marketId(), tick, mid);
  log.info("error-code probes complete", {
    checked: probes.length,
    matched: probes.filter((p) => p.matched).length,
    mismatched: probes.filter((p) => !p.matched).map((p) => `${p.label}=>${p.actual}`),
  });

  // Phase 5 — dead-man's-switch drill (once per install).
  await strategy.deliberateDeadmanFire();

  // Phase 6 — a few warm-up trading ticks.
  await runTicks(strategy, log, cfg.tickMs, cfg.once ? 4 : 3);

  // Phase 7 — reconnect drill: REST snapshot, kill, resync-then-resume + dedup.
  await reconnectDrill(api, state, ws, accountSeqs, log);

  // Phase 8 — the disruptive rate-limit probe (skipped in the light smoke's
  // default? no — run it once; it is the PAPI-2 correction proof).
  const rl = await probeRateLimit(api, state, log, cfg.deadmanMs.toString());
  if (rl) log.info("rate-limit probe", { matched: rl.matched, code: rl.actual });
  await strategy.armDeadman(); // re-arm after the burst

  // Phase 9 — withdrawal path. In the short smoke this is a small self-send
  // settle (fast). In the long soak it is DEFERRED to the confirmation-flow
  // exercise below, which must run first: it needs the rail address still
  // first-seen, which a small settle would consume.
  if (cfg.once) {
    await withdrawalCheck(api, state, log);
  }

  emitSummary(http, log, 0n, { phase: "startup-complete", accountSeqsSeen: accountSeqs.length });

  if (cfg.once) {
    log.info("smoke pass complete; shutting down", { findings: log.findings.length });
    ws.close();
    // let any in-flight alert pushes settle
    await new Promise((r) => setTimeout(r, 500));
    return;
  }

  // Unattended forever: trading loop + periodic summary + withdrawal path
  // (confirmation-flow exercise first, then periodic small settles).
  runLoopForever(strategy, api, state, store, http, log, cfg, ws, slotForRenew);
}

async function runTicks(strategy: Strategy, log: Logger, tickMs: number, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await strategy.tick().catch((e) => log.warn("tick error", { err: String(e) }));
    await new Promise((r) => setTimeout(r, Math.min(tickMs, 4000)));
  }
}

function runLoopForever(
  strategy: Strategy,
  api: Api,
  state: import("./state.ts").BotState,
  store: import("./state.ts").Store,
  http: HttpClient,
  log: Logger,
  cfg: import("./config.ts").Config,
  ws: WsClient,
  slot: number | null,
): void {
  const tick = setInterval(() => void strategy.tick().catch((e) => log.warn("tick error", { err: String(e) })), cfg.tickMs);
  // Renew the slot lease on the tick. A lease that stops being renewed is what
  // tells a later recreate this slot is free to inherit; losing it (another
  // instance took over) is logged, never silent — two bots on one account would
  // otherwise be invisible.
  const lease =
    slot === null
      ? undefined
      : setInterval(() => {
          if (!renewSlot(cfg.slotsDir, slot, cfg.instanceId)) {
            log.warn("slot lease lost — another instance holds it now", { slot });
          }
        }, cfg.tickMs);
  const summary = setInterval(() => emitSummary(http, log, 0n, { phase: "periodic" }), 6 * 3600 * 1000);
  // The confirmation-flow exercise and the periodic withdrawal settle are the
  // auditor's alone — they hammer the faucet toward the first-seen threshold and
  // exercise the rail. N traders doing this would multiply faucet/withdraw load
  // for no extra coverage, so traders skip both.
  void lease;
  let withdraw: ReturnType<typeof setInterval> | undefined;
  if (cfg.role === "auditor") {
    // Deliberately accumulate past the confirm threshold and exercise the 428
    // first-seen confirmation flow end to end — a one-shot, detached (it can take
    // hours). Must complete before any small settle consumes the first-seen rail.
    if (cfg.exerciseConfirm && !state.confirmExercised) {
      void exerciseConfirmationFlow(api, state, store, cfg, log).catch((e) =>
        log.warn("confirmation exercise error", { err: String(e) }),
      );
    }
    withdraw = setInterval(() => {
      // hold the periodic small settle until the confirmation flow has run (so it
      // does not consume the rail address's first-seen status first).
      if (cfg.exerciseConfirm && !state.confirmExercised) return;
      void withdrawalCheck(api, state, log).catch((e) => log.warn("withdrawal check error", { err: String(e) }));
    }, 12 * 3600 * 1000);
  }
  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    clearInterval(tick);
    clearInterval(summary);
    if (withdraw) clearInterval(withdraw);
    emitSummary(http, log, 0n, { phase: "shutdown" });
    ws.close();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  log.info("entered unattended loop", { tickMs: cfg.tickMs });
}

/**
 * Reconnect doctrine (#4): take a REST snapshot (newest history seq), kill the
 * socket, let it reconnect + resume, and verify no live seq ≤ the history seq
 * slipped through as a duplicate and none went missing.
 */
async function reconnectDrill(
  api: Api,
  state: import("./state.ts").BotState,
  ws: WsClient,
  accountSeqs: bigint[],
  log: Logger,
): Promise<void> {
  const fills = await api.fills(state.tradeKey, undefined, "1");
  const items = (fills.body as { fills?: Array<{ seq: string }> }).fills ?? [];
  const historySeqs = items.map((f) => BigInt(f.seq)).filter((n) => Number.isFinite(Number(n)));
  const before = accountSeqs.length;
  ws.kill();
  await waitFor(() => ws.isAuthed(), 15_000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 5000)); // allow a few post-reconnect frames
  const liveAfter = accountSeqs.slice(before);
  const { duplicates } = dedupAcrossReconnect(historySeqs, liveAfter);
  if (duplicates.length > 0) {
    log.finding({
      kind: "invariant:sequencing",
      summary: `reconnect: ${duplicates.length} live seq(s) ≤ newest history seq leaked (gap/dup)`,
      evidence: { duplicates: duplicates.map(String), historySeqs: historySeqs.map(String) },
    });
  } else {
    log.info("reconnect drill clean", { historySeqs: historySeqs.length, liveAfter: liveAfter.length });
  }
}

/** HB_PHASE_OFFSET_MS → a phase fraction in q9 of the (base) period. */
function phaseFrac(offsetMs: bigint, periodMs: bigint): bigint {
  if (periodMs <= 0n) return 0n;
  const m = ((offsetMs % periodMs) + periodMs) % periodMs;
  return (m * Q9) / periodMs;
}

function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("waitFor timeout"));
      }
    }, 250);
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ level: "fatal", msg: "unhandled", err: String(e?.stack ?? e) }));
  process.exit(1);
});
