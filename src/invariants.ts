/**
 * The eight invariant families from the PAPI-6 request, as reusable checkers.
 * The bot is a test, not just load: each violation is a finding with the
 * offending request/response captured verbatim. The runner (coverage.ts,
 * strategy.ts, ws.ts) calls these and forwards violations to Logger.finding().
 *
 * Everything here is pure and unit-tested; nothing reads the clock or network.
 */

/** Wire integer string (money/price/rate/time/count) pattern. */
const WIRE_INT = /^-?\d+$/;

/** Key suffixes that denote a monetary/precise field per the wire-encoding docs. */
const MONEY_SUFFIX = /(Msat|Q8|Q9|Contracts|TsMs|Seq)$/;
const MS_EXACT = /(^|[A-Za-z])Ms$/; // e.g. windowMs, oracleStalenessMs, timeoutMs

/** A key naming a decimal-string field (money/price/rate/time/count/cursor). */
function isMoneyKey(key: string): boolean {
  return MONEY_SUFFIX.test(key) || MS_EXACT.test(key) || key === "seq" || key === "rateQ9";
}

export interface FloatViolation {
  path: string;
  value: unknown;
  why: string;
}

/**
 * Invariant #3 — money never loses precision. Walk a decoded response and flag:
 *  (a) any monetary-named field carried as a JSON number (must be a string), and
 *  (b) any JSON number anywhere that is non-integer or beyond 2^53 (a float slipped in).
 * A single hit is a stop-everything finding.
 */
export function scanForFloatMoney(value: unknown, path = "$"): FloatViolation[] {
  const out: FloatViolation[] = [];
  const walk = (v: unknown, p: string, key: string | null): void => {
    if (typeof v === "number") {
      const monetary = key !== null && isMoneyKey(key);
      if (monetary) {
        out.push({ path: p, value: v, why: `monetary field "${key}" arrived as JSON number, must be a decimal string` });
      } else if (!Number.isSafeInteger(v)) {
        out.push({ path: p, value: v, why: `non-integer/unsafe JSON number where an exact integer was expected` });
      }
    } else if (typeof v === "string") {
      // A monetary-named string must be an exact wire integer and round-trip.
      if (key !== null && isMoneyKey(key) && v !== "" && !WIRE_INT.test(v)) {
        out.push({ path: p, value: v, why: `monetary field "${key}" is not a ^-?\\d+$ wire integer` });
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${p}[${i}]`, key));
    } else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) walk(val, `${p}.${k}`, k);
    }
  };
  walk(value, path, null);
  return out;
}

/**
 * Invariant #4 — sequencing. `seq` must be strictly monotonic increasing on the
 * account channel. Returns the first offending adjacent pair, or null if clean.
 */
export function firstNonMonotonic(seqs: bigint[]): { i: number; prev: bigint; cur: bigint } | null {
  for (let i = 1; i < seqs.length; i++) {
    const prev = seqs[i - 1]!;
    const cur = seqs[i]!;
    if (cur <= prev) return { i, prev, cur };
  }
  return null;
}

/**
 * Invariant #4 (cont.) — the reconnect dedup rule from the WebSocket docs:
 * "take a REST snapshot first, then resume the stream, and dedup on the event
 * seq — drop live seq ≤ newest history seq." Applying this to (historySeqs,
 * liveSeqs) must yield no gap and no duplicate.
 *
 * Returns the accepted live seqs (those strictly greater than the newest
 * history seq) and any duplicates that leaked through.
 */
export function dedupAcrossReconnect(
  historySeqs: bigint[],
  liveSeqs: bigint[],
): { accepted: bigint[]; duplicates: bigint[] } {
  const newestHistory = historySeqs.length ? historySeqs.reduce((a, b) => (b > a ? b : a)) : -1n;
  const historySet = new Set(historySeqs.map((s) => s.toString()));
  const accepted: bigint[] = [];
  const duplicates: bigint[] = [];
  for (const s of liveSeqs) {
    if (s <= newestHistory) {
      if (historySet.has(s.toString())) duplicates.push(s);
      // else: a live seq ≤ newest history but not in history would be a gap/hole
      else duplicates.push(s);
      continue;
    }
    accepted.push(s);
  }
  return { accepted, duplicates };
}

/** Invariant #5 — a cursor-paginated list returns a named-key envelope. */
export function isCursorEnvelope(body: unknown, itemsKey: string): boolean {
  if (!body || typeof body !== "object") return false;
  const o = body as Record<string, unknown>;
  return Array.isArray(o[itemsKey]) && "nextBeforeSeq" in o;
}

/** Convenience: assert a refusal carried the exact documented ErrorCode. */
export function codeMatches(actual: string | null, expected: string): boolean {
  return actual === expected;
}
