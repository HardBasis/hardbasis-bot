import { describe, it, expect } from "vitest";
import { needMsat } from "../src/confirm.ts";

describe("confirmation-flow accumulation target", () => {
  it("needs the threshold plus the fee (exact bigint, no float)", () => {
    // threshold 0.1 BTC (10,000,000 sats = 10,000,000,000 msat) + a fee
    expect(needMsat(10_000_000_000n, 0n)).toBe(10_000_000_000n);
    expect(needMsat(10_000_000_000n, 250_000n)).toBe(10_000_250_000n);
    expect(typeof needMsat(1n, 2n)).toBe("bigint");
  });
});
