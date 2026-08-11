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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger({
    logDir: cfg.logDir,
    maxBytes: cfg.logMaxBytes,
    maxFiles: cfg.logMaxFiles,
    ...(cfg.alertWebhookUrl ? { alertWebhookUrl: cfg.alertWebhookUrl } : {}),
    ...(cfg.alertNtfyUrl ? { alertNtfyUrl: cfg.alertNtfyUrl } : {}),
  });
  log.info("hardbasis-bot starting", { baseUrl: cfg.baseUrl, once: cfg.once });

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

  // Phase 2 — self-bootstrap.
  const store = new Store(cfg.stateDir);
  const state = await ensureBootstrapped(api, store, cfg, log, deployment);

  // Phase 3 — strategy + socket.
  const strategy = new Strategy(api, cfg, state, store, log);
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

  // Wait briefly for the first oracle mid so the signal has something to say.
  await waitFor(() => ws.lastMidQ8 !== null, 20_000);

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
  runLoopForever(strategy, api, state, store, http, log, cfg, ws);
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
): void {
  const tick = setInterval(() => void strategy.tick().catch((e) => log.warn("tick error", { err: String(e) })), cfg.tickMs);
  const summary = setInterval(() => emitSummary(http, log, 0n, { phase: "periodic" }), 6 * 3600 * 1000);
  // Deliberately accumulate past the confirm threshold and exercise the 428
  // first-seen confirmation flow end to end — a one-shot, detached (it can take
  // hours). Must complete before any small settle consumes the first-seen rail.
  if (cfg.exerciseConfirm && !state.confirmExercised) {
    void exerciseConfirmationFlow(api, state, store, cfg, log).catch((e) =>
      log.warn("confirmation exercise error", { err: String(e) }),
    );
  }
  const withdraw = setInterval(() => {
    // hold the periodic small settle until the confirmation flow has run (so it
    // does not consume the rail address's first-seen status first).
    if (cfg.exerciseConfirm && !state.confirmExercised) return;
    void withdrawalCheck(api, state, log).catch((e) => log.warn("withdrawal check error", { err: String(e) }));
  }, 12 * 3600 * 1000);
  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    clearInterval(tick);
    clearInterval(summary);
    clearInterval(withdraw);
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
