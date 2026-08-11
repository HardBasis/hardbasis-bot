/**
 * The trading signal — deliberately simple. Coverage and endurance, not alpha
 * (per the request). A slow EMA of the oracle mid with a hysteresis band drives
 * a low-frequency long/short target, so the bot maintains a small oscillating
 * position that a person could plausibly run.
 *
 * Pure bigint math on q8 prices: no float ever touches a price. Deterministic
 * given a price sequence, so it is unit-tested against fixtures.
 */
import { Q9 } from "./money.ts";

export type Target = "long" | "short" | "flat";

export interface SignalState {
  emaQ8: bigint | null;
  target: Target;
}

export interface SignalParams {
  /** EMA smoothing denominator N (alpha = 1/N); larger = slower. */
  n: bigint;
  /** hysteresis band in q9 (3_000_000n = 0.003 = 30 bps) to avoid chatter. */
  bandQ9: bigint;
}

export const DEFAULT_SIGNAL: SignalParams = { n: 32n, bandQ9: 3_000_000n };

export function initSignal(): SignalState {
  return { emaQ8: null, target: "flat" };
}

/**
 * Advance the signal by one oracle mid (q8). Returns the next state; the caller
 * acts on `target`. Integer EMA: ema += (mid - ema) / N (truncated toward the
 * mid, which is fine for a slow signal).
 */
export function step(state: SignalState, midQ8: bigint, params: SignalParams = DEFAULT_SIGNAL): SignalState {
  if (state.emaQ8 === null) {
    return { emaQ8: midQ8, target: state.target };
  }
  const ema = state.emaQ8 + (midQ8 - state.emaQ8) / params.n;
  if (ema === 0n) return { emaQ8: ema, target: state.target };
  // deviation of mid from the slow line, in q9
  const deviationQ9 = ((midQ8 - ema) * Q9) / (ema < 0n ? -ema : ema);
  let target = state.target;
  if (deviationQ9 > params.bandQ9) target = "long";
  else if (deviationQ9 < -params.bandQ9) target = "short";
  return { emaQ8: ema, target };
}
