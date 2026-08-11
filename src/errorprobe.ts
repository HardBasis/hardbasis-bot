/**
 * Invariant #1 — error codes match the docs. Deliberately provoke each
 * client-reachable documented ErrorCode and assert the returned `code` is the
 * one the Errors page (https://docs.hardbasis.com/api/errors) documents. This
 * is continuous docs-vs-reality verification — the highest-value assertion here.
 *
 * Some documented codes are not reproducible from a well-behaved client on a
 * healthy testnet market (market_halted, oracle_stale, oi_cap, position_limit,
 * compliance_refused, deposits_halted, unavailable, conflict, feature_unavailable).
 * Those are reported as "not client-reproducible" rather than silently skipped.
 */
import { randomUUID } from "node:crypto";
import type { Api } from "./api.ts";
import type { Logger } from "./logger.ts";
import type { BotState } from "./state.ts";

export interface ProbeResult {
  label: string;
  expected: string;
  status: number;
  actual: string | null;
  matched: boolean;
  evidence: unknown;
}

// A syntactically-plausible but never-real key for the 401 probe. Deliberately
// NOT hex (underscores) so it can never match the committed-key guard's
// hb_[0-9a-f]{32} pattern — the probe needs an *unknown* key, not a valid shape.
const BOGUS_KEY = "hb_bogus_unknown_key_for_401_probe_x";

export async function runErrorProbes(
  api: Api,
  state: BotState,
  log: Logger,
  marketId: string,
  tickSizeQ8: bigint,
  midQ8: bigint,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const trade = state.tradeKey;
  const record = (
    label: string,
    expected: string,
    r: { status: number; code: string | null; request?: unknown; body?: unknown },
  ): ProbeResult => {
    const res: ProbeResult = {
      label,
      expected,
      status: r.status,
      actual: r.code,
      matched: r.code === expected,
      evidence: { request: r.request, status: r.status, body: r.body },
    };
    results.push(res);
    if (!res.matched) {
      log.finding({
        kind: "invariant:error-code",
        summary: `${label}: expected code "${expected}", got "${r.code}" (status ${r.status})`,
        evidence: res.evidence,
      });
    }
    return res;
  };

  // unauthorized — no/unknown key
  record("unauthorized(account w/ bogus key)", "unauthorized", await api.http.get("/v1/account", { key: BOGUS_KEY }));

  // insufficient_scope — read+trade key attempting a withdraw (needs `withdraw`)
  record(
    "insufficient_scope(withdraw w/ trade key)",
    "insufficient_scope",
    await api.withdraw(trade, { amountMsat: "1000", toAddress: "sprt1qexample0000000000000000000000" }),
  );

  // not_found — unknown market
  record("not_found(unknown market)", "not_found", await api.market("__no_such_market__"));

  // validation — malformed order on a REAL market (zero contracts)
  record(
    "validation(zero-contract order)",
    "validation",
    await api.placeOrder(trade, { marketId, side: "buy", type: "market", contracts: "0", reduceOnly: false }),
  );

  // idempotency_key_reused — same key, different order body (the idempotency-key
  // IS the order id, so a reuse with a different body must be refused 409).
  {
    const key = randomUUID();
    await api.placeOrder(trade, { marketId, side: "buy", type: "market", contracts: "1", reduceOnly: false }, { idempotencyKey: key });
    const r = await api.placeOrder(trade, { marketId, side: "buy", type: "market", contracts: "2", reduceOnly: false }, { idempotencyKey: key });
    record("idempotency_key_reused(order)", "idempotency_key_reused", r);
  }

  // body_too_large — an oversized body. Reality: a 2MB body is rejected by the
  // nginx proxy as an HTML 413 (no JSON `code`) BEFORE it reaches the gateway,
  // so the documented `body_too_large` code is not observable this way.
  {
    const big = JSON.stringify({ marketId, side: "buy", type: "market", contracts: "1", reduceOnly: false, pad: "x".repeat(2_000_000) });
    const r = await api.http.post("/v1/orders", { key: trade, rawBody: big, noRetry: true });
    const res: ProbeResult = { label: "body_too_large(2MB body)", expected: "body_too_large", status: r.status, actual: r.code, matched: r.code === "body_too_large", evidence: { status: r.status } };
    results.push(res);
    if (r.status === 413 && r.code === null) {
      log.finding({
        kind: "docs-vs-reality",
        summary: "body_too_large: a 2MB body is rejected by the nginx proxy as an HTML 413 with no JSON `code`; the documented body_too_large code is not observable at the client",
        evidence: { status: r.status, bodyPrefix: String(r.raw).slice(0, 120) },
      });
    } else if (!res.matched) {
      log.finding({ kind: "invariant:error-code", summary: `body_too_large: got code "${r.code}" (status ${r.status})`, evidence: { status: r.status } });
    }
  }

  // trigger level not tick-aligned — a routine client mistake. A bad client
  // value should be a 400 validation; the gateway returns 500 "internal error"
  // with no code. Asserted continuously so a fix is detected.
  {
    const aligned = (midQ8 / tickSizeQ8) * tickSizeQ8;
    const unaligned = (aligned - aligned / 5n + 1n).toString(); // deliberately off the tick
    const r = await api.placeOrder(trade, { marketId, side: "sell", type: "stop_market", contracts: "1", reduceOnly: false, trigger: { kind: "stop", level: unaligned } });
    const res: ProbeResult = { label: "unaligned-trigger-level", expected: "validation", status: r.status, actual: r.code, matched: r.code === "validation", evidence: { status: r.status, body: r.body } };
    results.push(res);
    if (!res.matched) {
      log.finding({
        kind: "invariant:error-code",
        summary: `unaligned trigger level returned ${r.status}/${r.code ?? "no code"} — expected a 400 "validation"; an un-tick-aligned level should not 500`,
        evidence: { request: r.request, status: r.status, body: r.body, tickSizeQ8: tickSizeQ8.toString() },
      });
    }
  }

  // Observation: deposit-invoices does NOT enforce idempotency-key reuse — the
  // same key with a different body returns a fresh 201 invoice.
  {
    const key = randomUUID();
    await api.http.post("/v1/deposit-invoices", { key: trade, idempotencyKey: key, body: { amountMsat: "1000" } });
    const r = await api.http.post("/v1/deposit-invoices", { key: trade, idempotencyKey: key, body: { amountMsat: "2000" } });
    if (r.status === 201) {
      log.finding({
        kind: "docs-vs-reality",
        summary: "POST /v1/deposit-invoices ignores idempotency-key reuse: the same key with a different body returns a NEW 201 invoice rather than 409 idempotency_key_reused",
        evidence: { request: r.request, status: r.status },
      });
    }
  }

  return results;
}

/**
 * rate_limited — deliberately exhaust the ORDER budget by bursting
 * cancel-all-after (which draws the order budget and only re-arms the
 * dead-man's-switch, no destructive effect), asserting a 429 carries
 * Retry-After and code:"rate_limited". Separate because it is disruptive; the
 * caller re-arms the switch afterwards.
 */
export async function probeRateLimit(api: Api, state: BotState, log: Logger, deadmanMs: string): Promise<ProbeResult | null> {
  let last: { status: number; code: string | null; rateLimit: { retryAfterS: number | null }; request?: unknown; body?: unknown } | null = null;
  for (let i = 0; i < 40; i++) {
    const r = await api.http.post("/v1/cancel-all-after", { key: state.tradeKey, body: { timeoutMs: deadmanMs }, noRetry: true });
    last = r;
    if (r.status === 429) {
      const hasRetry = r.rateLimit.retryAfterS !== null;
      const res: ProbeResult = {
        label: "rate_limited(order-budget burst)",
        expected: "rate_limited",
        status: 429,
        actual: r.code,
        matched: r.code === "rate_limited" && hasRetry,
        evidence: { request: r.request, retryAfterS: r.rateLimit.retryAfterS, body: r.body },
      };
      if (!res.matched) {
        log.finding({
          kind: "invariant:rate-limit",
          summary: `429 code="${r.code}" retryAfter=${r.rateLimit.retryAfterS} (expected code "rate_limited" + Retry-After)`,
          evidence: res.evidence,
        });
      }
      return res;
    }
  }
  log.finding({
    kind: "invariant:rate-limit",
    summary: "could not exhaust the order budget in 40 bursts; no 429 observed",
    evidence: { last },
  });
  return null;
}
