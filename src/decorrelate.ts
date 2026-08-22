/**
 * Per-instance decorrelation. Identical strategies make N bots behave as one —
 * all flipping together, swinging skew and distorting funding. This module turns
 * a slot ordinal (0,1,2,…) into a distinct trading personality so a fleet is
 * two-sided by construction and does not synchronise.
 *
 * Four knobs, exactly the ones the request names — period, phase, size, and
 * direction bias (stance):
 *
 *   - **stance**  — slot parity: even = momentum (follow the wave), odd =
 *     mean-revert (fade it). So slot 0 and slot 1 lean OPPOSITE: at least one
 *     trader always takes the other side. Guaranteed two-sidedness, not luck.
 *   - **phase**   — a low-discrepancy golden-ratio spread across the cycle, so
 *     two traders do not flip at the same instant even at the same period.
 *   - **period**  — the oscillation period, jittered ±jitterPct off the base by
 *     a deterministic hash of the slot, so reaction speeds differ.
 *   - **size**    — order size, jittered the same way.
 *
 * Any knob may be pinned by env (HB_STANCE / HB_PHASE_OFFSET_MS /
 * HB_SIGNAL_PERIOD_MS / HB_ORDER_CONTRACTS) for an explicitly-configured fleet
 * of distinct services; unpinned, it is derived from the slot.
 *
 * The trader target is a time-driven triangle wave in pure bigint q9 — no float
 * ever touches it, and it is deterministic given (now, profile), so it is unit
 * tested with an injected clock. (The auditor keeps the price-EMA signal in
 * signal.ts; traders use this oscillator for guaranteed decorrelated flow.)
 */
import { Q9 } from "./money.ts";
import type { Target } from "./signal.ts";

export type Stance = "momentum" | "meanrevert";

export interface Profile {
  slot: number;
  stance: Stance;
  /** oscillation period in ms */
  periodMs: bigint;
  /** phase offset as a fraction of the period, in q9 (0 ≤ p < 1e9) */
  phaseFracQ9: bigint;
  /** order size per flip, contracts */
  orderContracts: bigint;
  /** flat band around the zero-crossing, q9, to avoid chatter at the flip */
  bandQ9: bigint;
  /** how long this slot waits before its first signup, ms (staggers the fleet) */
  staggerMs: number;
}

export interface ProfileBase {
  periodMs: bigint;
  orderContracts: bigint;
  bandQ9: bigint;
  staggerStepMs: number;
  /** max ± percent jitter applied to period and size */
  jitterPct: number;
}

export interface ProfileOverrides {
  stance?: Stance;
  phaseFracQ9?: bigint;
  periodMs?: bigint;
  orderContracts?: bigint;
}

// φ−1 in q9: a low-discrepancy multiplier so slot·GOLDEN mod 1 spreads phases
// evenly however many slots there are (0, .618, .236, .854, .472, …).
const GOLDEN_Q9 = 618_033_989n;

/** Deterministic 32-bit FNV-1a of a small integer, for symmetric jitter. */
function hash32(n: number): number {
  let h = 0x811c9dc5;
  // fold the four bytes of n; non-crypto, just needs to scramble small ints
  for (let i = 0; i < 4; i++) {
    h ^= (n >>> (i * 8)) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Apply a symmetric ±jitterPct jitter to a bigint base, keyed by (seed,salt). */
function jitter(base: bigint, seed: number, jitterPct: number): bigint {
  if (jitterPct <= 0) return base;
  const span = 2 * jitterPct + 1; // [-jitterPct, +jitterPct]
  const pct = BigInt((seed % span) - jitterPct);
  const out = base + (base * pct) / 100n;
  return out > 0n ? out : base; // never let jitter drive it to zero/negative
}

/** Derive a distinct trading personality for a slot. Pure and deterministic. */
export function deriveProfile(slot: number, base: ProfileBase, ov: ProfileOverrides = {}): Profile {
  const seed = hash32(slot);
  const stance: Stance = ov.stance ?? (slot % 2 === 0 ? "momentum" : "meanrevert");
  const phaseFracQ9 = ov.phaseFracQ9 ?? (BigInt(slot) * GOLDEN_Q9) % Q9;
  const periodMs = ov.periodMs ?? jitter(base.periodMs, seed, base.jitterPct);
  const orderContracts = ov.orderContracts ?? jitter(base.orderContracts, hash32(seed), base.jitterPct);
  const staggerMs = Math.max(0, slot) * base.staggerStepMs;
  return { slot, stance, periodMs, phaseFracQ9, orderContracts, bandQ9: base.bandQ9, staggerMs };
}

/**
 * Signed triangle wave in q9 over [-1e9, +1e9]: −1 at the cycle start, +1 at the
 * midpoint, −1 at the end, crossing zero at the quarter and three-quarter marks.
 * Spends half the cycle positive and half negative. Pure bigint.
 */
export function triangleQ9(nowMs: bigint, periodMs: bigint, phaseFracQ9: bigint): bigint {
  if (periodMs <= 0n) return 0n;
  const phaseMs = (phaseFracQ9 * periodMs) / Q9;
  const t = (((nowMs + phaseMs) % periodMs) + periodMs) % periodMs; // [0, period)
  const xQ9 = (t * Q9) / periodMs; // [0, Q9)
  const half = Q9 / 2n;
  return xQ9 < half ? 4n * xQ9 - Q9 : 3n * Q9 - 4n * xQ9;
}

/** The trader's long/short/flat target at wall-clock `nowMs`, from its profile. */
export function oscTarget(nowMs: number, p: Profile): Target {
  const tri = triangleQ9(BigInt(Math.floor(nowMs)), p.periodMs, p.phaseFracQ9);
  const signed = p.stance === "meanrevert" ? -tri : tri;
  if (signed > p.bandQ9) return "long";
  if (signed < -p.bandQ9) return "short";
  return "flat";
}
