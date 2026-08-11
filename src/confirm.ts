/**
 * Deliberately exercise the first-seen withdrawal CONFIRMATION flow (HTTP 428
 * confirmation_required) end to end — the path the short smoke records as "not
 * reachable" because a fresh faucet balance is below the confirm threshold.
 *
 * The threshold is served, not assumed: a withdrawal quote returns
 * `confirmThresholdMsat`. This routine draws the testnet faucet on a normal
 * cadence (respecting its rate limit) until the free balance clears the
 * threshold, then, on the account's OWN rail address (still first-seen because
 * this runs before any other withdrawal), it:
 *   1. quotes at the threshold → expects firstSeen + confirmRequired + a token,
 *   2. withdraws WITHOUT the token → asserts 428 confirmation_required (no money
 *      moves — a 428 is a refusal),
 *   3. withdraws WITH the token → asserts it settles.
 *
 * All public-API only (faucet / account / withdrawals[/quote]); nothing here
 * knows the faucet amount or rate a priori — it discovers them.
 */
import type { Api } from "./api.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Store, BotState } from "./state.ts";
import { sleep } from "./http.ts";
import { parseWireInt, parseWireIntOrNull } from "./money.ts";
import { scanForFloatMoney } from "./invariants.ts";

/** Free balance needed to settle a threshold-sized confirmed withdrawal. */
export function needMsat(thresholdMsat: bigint, feeMsat: bigint): bigint {
  return thresholdMsat + feeMsat;
}

export async function exerciseConfirmationFlow(
  api: Api,
  state: BotState,
  store: Store,
  cfg: Config,
  log: Logger,
  now: () => number = Date.now,
): Promise<void> {
  if (state.confirmExercised) return;
  const withdrawKey = state.withdrawKey ?? state.masterKey;

  const acct0 = await api.account(state.tradeKey);
  if (!acct0.ok) {
    log.warn("confirm exercise: cannot read account", { status: acct0.status });
    return;
  }
  const railAddress = acct0.body.railAddress;
  if (!railAddress) return;

  // Learn the threshold + fee from a small quote to our own (first-seen) address.
  const probe = await api.withdrawQuote(state.tradeKey, { toAddress: railAddress, amountMsat: "1000" });
  if (!probe.ok) {
    log.warn("confirm exercise: quote refused", { status: probe.status, code: probe.code });
    return;
  }
  scanForFloatMoney(probe.body, "withdraw-quote");
  const threshold = parseWireIntOrNull(probe.body.confirmThresholdMsat ?? null, "confirmThresholdMsat");
  if (threshold === null) {
    log.finding({
      kind: "docs-gap",
      summary: "withdrawal quote returned no confirmThresholdMsat; the confirmation flow cannot be exercised",
      evidence: { body: probe.body },
    });
    return;
  }
  if (probe.body.firstSeen === false) {
    log.warn("confirm exercise: rail address is no longer first-seen; skipping this install", {});
    return;
  }
  const feeMsat = parseWireIntOrNull(probe.body.feeMsat ?? null, "feeMsat") ?? 0n;
  const need = needMsat(threshold, feeMsat);
  log.info("confirm exercise: accumulating toward the confirm threshold", {
    thresholdMsat: threshold.toString(),
    needMsat: need.toString(),
    faucetDraws: state.faucetDraws,
    maxFaucetDraws: cfg.maxFaucetDraws,
  });

  // Accumulate by faucet draws, respecting the faucet's own rate limit (429).
  for (;;) {
    const acct = await api.account(state.tradeKey);
    if (!acct.ok) return;
    const free = parseWireInt(acct.body.freeMsat, "freeMsat");
    if (free >= need) break;
    if (state.faucetDraws >= cfg.maxFaucetDraws) {
      log.finding({
        kind: "friction",
        summary: `faucet draw cap (${cfg.maxFaucetDraws}) reached before the confirm threshold: free=${free} need=${need}. Raise HB_MAX_FAUCET_DRAWS to exercise the confirmation flow.`,
        evidence: { freeMsat: free.toString(), needMsat: need.toString() },
      });
      return;
    }
    const f = await api.faucet(state.masterKey);
    if (f.ok) {
      state.faucetDraws += 1;
      store.save(state);
      log.info("confirm exercise: faucet draw", { faucetDraws: state.faucetDraws, freeMsat: free.toString() });
      await sleep(cfg.faucetPaceMs);
    } else if (f.status === 429) {
      const waitS = f.rateLimit.retryAfterS ?? 1800;
      const waitMs = Math.min(Math.max(waitS, 1) * 1000, cfg.faucetMaxWaitMs);
      log.info("confirm exercise: faucet rate-limited; waiting for the window", { waitMs });
      await sleep(waitMs);
    } else {
      log.warn("confirm exercise: faucet refused", { status: f.status, code: f.code });
      return;
    }
  }

  // Threshold cleared and the rail address is still first-seen: get the token.
  const q = await api.withdrawQuote(state.tradeKey, { toAddress: railAddress, amountMsat: threshold.toString() });
  if (!q.ok) {
    log.warn("confirm exercise: threshold quote refused", { status: q.status, code: q.code });
    return;
  }
  scanForFloatMoney(q.body, "withdraw-quote");
  if (q.body.confirmRequired !== true || !q.body.confirmToken) {
    log.finding({
      kind: "friction",
      summary: `expected confirmRequired + confirmToken for a first-seen ≥threshold quote, got confirmRequired=${q.body.confirmRequired}`,
      evidence: { request: q.request, body: q.body },
    });
    return;
  }

  // 1) tokenless withdraw at the threshold → must be refused 428 (no money moves)
  const refused = await api.withdraw(
    withdrawKey,
    { amountMsat: threshold.toString(), toAddress: railAddress },
    { noRetry: true },
  );
  if (refused.status === 428 && refused.code === "confirmation_required") {
    log.info("confirm exercise: 428 confirmation_required correctly refused the tokenless withdraw");
  } else {
    log.finding({
      kind: "invariant:error-code",
      summary: `first-seen ≥threshold withdraw WITHOUT a confirmToken: expected 428 confirmation_required, got ${refused.status}/${refused.code}`,
      evidence: { request: refused.request, status: refused.status, body: refused.body },
    });
  }

  // 2) withdraw WITH the token → settles (self-send; funds cycle back)
  const done = await api.withdraw(withdrawKey, {
    amountMsat: threshold.toString(),
    toAddress: railAddress,
    confirmToken: q.body.confirmToken,
  });
  if (!done.ok) {
    log.finding({
      kind: "friction",
      summary: `confirmed (token-bearing) withdraw at the threshold was refused: ${done.status}/${done.code}`,
      evidence: { request: done.request, body: done.body },
    });
    return;
  }
  scanForFloatMoney(done.body, "withdraw");
  log.info("confirm exercise: confirmed withdraw accepted", { railRef: done.body.railRef, queued: done.body.queued });

  // confirm it settles
  const deadline = now() + 90_000;
  while (now() < deadline) {
    await sleep(3000);
    const list = await api.withdrawals(state.tradeKey, undefined, "1");
    scanForFloatMoney(list.body, "withdrawals");
    const items = (list.body as { withdrawals?: Array<{ state: string; path: string }> }).withdrawals ?? [];
    const latest = items[0];
    if (latest && latest.state === "paid") {
      log.info("confirm exercise: confirmation flow settled end to end", { state: latest.state, path: latest.path });
      break;
    }
  }
  state.confirmExercised = true;
  store.save(state);
}
