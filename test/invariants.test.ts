import { describe, it, expect } from "vitest";
import {
  scanForFloatMoney,
  firstNonMonotonic,
  dedupAcrossReconnect,
  isCursorEnvelope,
  codeMatches,
} from "../src/invariants.ts";

describe("scanForFloatMoney (#3 precision)", () => {
  it("passes a clean wire payload of decimal strings", () => {
    const clean = {
      freeMsat: "1000",
      lastPrice: { midQ8: "6724150000000", tsMs: "1712345678000" },
      fills: 3, // documented integer count — a legit JSON number
      interval: 60, // documented number
      candles: [{ oQ8: "100", prints: 0 }],
      nextBeforeSeq: null,
    };
    expect(scanForFloatMoney(clean)).toEqual([]);
  });

  it("flags a monetary field carried as a JSON number", () => {
    const v = scanForFloatMoney({ freeMsat: 1000 });
    expect(v).toHaveLength(1);
    expect(v[0]!.why).toMatch(/JSON number/);
  });

  it("flags a float that slipped in anywhere", () => {
    const v = scanForFloatMoney({ ratio: 1.5 });
    expect(v).toHaveLength(1);
  });

  it("flags a monetary string that is not a wire integer", () => {
    const v = scanForFloatMoney({ feeMsat: "1.5" });
    expect(v).toHaveLength(1);
  });

  it("catches lowercase seq and windowMs as monetary", () => {
    expect(scanForFloatMoney({ seq: 5 })).toHaveLength(1);
    expect(scanForFloatMoney({ windowMs: 5 })).toHaveLength(1);
  });

  it("walks nested arrays and objects", () => {
    const v = scanForFloatMoney({ withdrawals: [{ amountMsat: "1" }, { amountMsat: 2 }] });
    expect(v).toHaveLength(1);
    expect(v[0]!.path).toBe("$.withdrawals[1].amountMsat");
  });
});

describe("firstNonMonotonic (#4 sequencing)", () => {
  it("returns null for a strictly increasing seq", () => {
    expect(firstNonMonotonic([1n, 2n, 5n, 9n])).toBeNull();
  });
  it("catches a non-increasing pair", () => {
    expect(firstNonMonotonic([1n, 2n, 2n])).toEqual({ i: 2, prev: 2n, cur: 2n });
    expect(firstNonMonotonic([5n, 3n])).toEqual({ i: 1, prev: 5n, cur: 3n });
  });
});

describe("dedupAcrossReconnect (#4 reconnect)", () => {
  it("accepts only live seqs strictly greater than newest history", () => {
    const { accepted, duplicates } = dedupAcrossReconnect([10n, 11n, 12n], [11n, 12n, 13n, 14n]);
    expect(accepted).toEqual([13n, 14n]);
    expect(duplicates).toEqual([11n, 12n]);
  });
  it("no gap and no duplicate when the stream resumes cleanly", () => {
    const { accepted, duplicates } = dedupAcrossReconnect([12n], [13n, 14n, 15n]);
    expect(accepted).toEqual([13n, 14n, 15n]);
    expect(duplicates).toEqual([]);
  });
});

describe("isCursorEnvelope (#5 envelopes)", () => {
  it("true for a named-key + nextBeforeSeq envelope", () => {
    expect(isCursorEnvelope({ fills: [], nextBeforeSeq: null }, "fills")).toBe(true);
  });
  it("false for a bare array or a missing cursor", () => {
    expect(isCursorEnvelope([], "fills")).toBe(false);
    expect(isCursorEnvelope({ fills: [] }, "fills")).toBe(false);
  });
});

describe("codeMatches (#1 error codes)", () => {
  it("exact-matches the documented code", () => {
    expect(codeMatches("unauthorized", "unauthorized")).toBe(true);
    expect(codeMatches("rate_limited", "unauthorized")).toBe(false);
    expect(codeMatches(null, "unauthorized")).toBe(false);
  });
});
