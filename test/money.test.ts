import { describe, it, expect } from "vitest";
import { parseWireInt, parseWireIntOrNull, roundTrips, msatToSats, q8ToUsd, q9ToPct, PrecisionError } from "../src/money.ts";

describe("parseWireInt", () => {
  it("parses valid wire integers to bigint", () => {
    expect(parseWireInt("1000")).toBe(1000n);
    expect(parseWireInt("-5")).toBe(-5n);
    expect(parseWireInt("6724150000000")).toBe(6724150000000n);
    expect(parseWireInt("0")).toBe(0n);
  });

  it("REJECTS a JSON number — the precision bug we guard against", () => {
    expect(() => parseWireInt(1000 as unknown)).toThrow(PrecisionError);
    expect(() => parseWireInt(1.5 as unknown)).toThrow(PrecisionError);
  });

  it("rejects floats, exponents, empty, junk strings", () => {
    for (const bad of ["1.0", "1e3", "", " 5", "0x10", "abc", "+5", "1_000", "NaN"]) {
      expect(() => parseWireInt(bad), bad).toThrow(PrecisionError);
    }
  });

  it("handles nullable", () => {
    expect(parseWireIntOrNull(null)).toBeNull();
    expect(parseWireIntOrNull(undefined)).toBeNull();
    expect(parseWireIntOrNull("7")).toBe(7n);
  });

  it("never loses precision beyond 2^53", () => {
    const big = "9007199254740993"; // 2^53 + 1, not representable as a double
    expect(parseWireInt(big)).toBe(9007199254740993n);
    expect(parseWireInt(big).toString()).toBe(big);
  });
});

describe("roundTrips", () => {
  it("true for canonical integers", () => {
    expect(roundTrips("1000")).toBe(true);
    expect(roundTrips("-5")).toBe(true);
    expect(roundTrips("0")).toBe(true);
  });
  it("false for non-canonical or non-integer", () => {
    expect(roundTrips("007")).toBe(false);
    expect(roundTrips("1.0")).toBe(false);
    expect(roundTrips("")).toBe(false);
  });
});

describe("conversions (exact integer math)", () => {
  it("msat → sats truncates toward zero", () => {
    expect(msatToSats(1000n)).toBe(1n);
    expect(msatToSats(1999n)).toBe(1n);
    expect(msatToSats(50_000n)).toBe(50n);
  });
  it("q8 → usd display", () => {
    expect(q8ToUsd(6724150000000n)).toBe("67241.5");
    expect(q8ToUsd(100000000n)).toBe("1");
    expect(q8ToUsd(0n)).toBe("0");
  });
  it("q9 → percent display", () => {
    expect(q9ToPct(300000n)).toBe("0.03%"); // 3 bps
    expect(q9ToPct(10000000n)).toBe("1%");
  });
});
