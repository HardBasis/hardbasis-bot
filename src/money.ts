/**
 * Wire-number handling. Built from https://docs.hardbasis.com/api/wire-encoding.
 *
 * Every monetary value — money, prices, rates, timestamps, contract counts —
 * crosses the wire as a DECIMAL STRING, never a JSON number, because an IEEE
 * double cannot hold a satoshi-precise integer. A field's JSON type is
 * `string`, validated against `^-?\d+$`. We parse into `bigint` and never let a
 * value pass through `Number`/`parseFloat`.
 *
 * This module is the single choke point for that rule, so invariant #3 ("money
 * never loses precision") is a property of one small, unit-tested file.
 */

/** The unit tags the spec attaches via `x-hardbasis-unit`. */
export type Unit = "msat" | "sats" | "q8" | "q9" | "ms" | "seq" | "contracts" | "int";

/** Exact integer scale of each unit that has a fractional interpretation. */
export const MSAT_PER_SAT = 1000n;
export const SATS_PER_BTC = 100_000_000n;
export const Q8 = 100_000_000n; // price scale (1e8)
export const Q9 = 1_000_000_000n; // rate scale (1e9)

const WIRE_INT = /^-?\d+$/;

export class PrecisionError extends Error {
  constructor(
    message: string,
    readonly field: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = "PrecisionError";
  }
}

/**
 * Parse a wire integer string into bigint. Rejects anything that is not an
 * exact `^-?\d+$` — a float, a number, `NaN`, `""`, `"1e3"`, `"1.0"`. A single
 * precision loss is a stop-everything finding, so this throws rather than
 * coercing.
 */
export function parseWireInt(raw: unknown, field = "<field>"): bigint {
  if (typeof raw === "number") {
    // A JSON number for a monetary field is itself the bug we are guarding
    // against: it may already have lost precision before we ever see it.
    throw new PrecisionError(
      `field ${field} arrived as a JSON number (${raw}); monetary fields must be decimal strings`,
      field,
      raw,
    );
  }
  if (typeof raw !== "string" || !WIRE_INT.test(raw)) {
    throw new PrecisionError(`field ${field} is not a wire integer string: ${JSON.stringify(raw)}`, field, raw);
  }
  return BigInt(raw);
}

/** Parse a nullable wire integer: `null` → null, otherwise `parseWireInt`. */
export function parseWireIntOrNull(raw: unknown, field = "<field>"): bigint | null {
  if (raw === null || raw === undefined) return null;
  return parseWireInt(raw, field);
}

/**
 * Round-trip check: the string is a valid wire integer AND already canonical —
 * `BigInt(raw).toString()` equals it exactly. A non-canonical form ("007",
 * "-0", "1.0") returns false; parsing then re-serialising must be the identity.
 */
export function roundTrips(raw: string): boolean {
  if (!WIRE_INT.test(raw)) return false;
  return BigInt(raw).toString() === raw;
}

/** msat → whole sats, truncating toward zero (never invents a fractional sat). */
export function msatToSats(msat: bigint): bigint {
  return msat / MSAT_PER_SAT;
}

/** q8 price integer → a human dollar string (display only; not for math). */
export function q8ToUsd(q8: bigint): string {
  const neg = q8 < 0n;
  const abs = neg ? -q8 : q8;
  const whole = abs / Q8;
  const frac = (abs % Q8).toString().padStart(8, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** q9 rate integer → percent string (display only). */
export function q9ToPct(q9: bigint): string {
  // rate = q9 / 1e9; percent = rate * 100. Keep it exact-ish for display.
  const bps = (q9 * 10_000n) / Q9; // basis points, truncated
  return `${Number(bps) / 100}%`;
}

/** Format a bigint back to a wire string (identity for transport). */
export function toWire(v: bigint): string {
  return v.toString();
}
