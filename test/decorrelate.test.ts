import { describe, it, expect } from "vitest";
import { deriveProfile, triangleQ9, oscTarget, type ProfileBase } from "../src/decorrelate.ts";
import { Q9 } from "../src/money.ts";

const BASE: ProfileBase = {
  periodMs: 600_000n,
  orderContracts: 500n,
  bandQ9: 50_000_000n,
  staggerStepMs: 30_000,
  jitterPct: 30,
};

describe("deriveProfile", () => {
  it("assigns opposing stances by slot parity (guaranteed two-sidedness)", () => {
    expect(deriveProfile(0, BASE).stance).toBe("momentum");
    expect(deriveProfile(1, BASE).stance).toBe("meanrevert");
    expect(deriveProfile(2, BASE).stance).toBe("momentum");
    expect(deriveProfile(3, BASE).stance).toBe("meanrevert");
  });

  it("spreads phase across the cycle so slots do not flip in unison", () => {
    const p0 = deriveProfile(0, BASE).phaseFracQ9;
    const p1 = deriveProfile(1, BASE).phaseFracQ9;
    const p2 = deriveProfile(2, BASE).phaseFracQ9;
    expect(p0).toBe(0n);
    expect(p1).not.toBe(p0);
    expect(p2).not.toBe(p1);
    // all phases are valid fractions in [0, Q9)
    for (const p of [p0, p1, p2]) {
      expect(p >= 0n).toBe(true);
      expect(p < Q9).toBe(true);
    }
  });

  it("jitters period and size deterministically, never to zero", () => {
    const a = deriveProfile(5, BASE);
    const b = deriveProfile(5, BASE);
    expect(a.periodMs).toBe(b.periodMs); // deterministic
    expect(a.orderContracts).toBe(b.orderContracts);
    expect(a.periodMs > 0n).toBe(true);
    expect(a.orderContracts > 0n).toBe(true);
    // within ±jitterPct of the base
    expect(a.periodMs >= (BASE.periodMs * 70n) / 100n).toBe(true);
    expect(a.periodMs <= (BASE.periodMs * 130n) / 100n).toBe(true);
  });

  it("staggers signup by slot", () => {
    expect(deriveProfile(0, BASE).staggerMs).toBe(0);
    expect(deriveProfile(1, BASE).staggerMs).toBe(30_000);
    expect(deriveProfile(3, BASE).staggerMs).toBe(90_000);
  });

  it("honors env pins (stance, phase) as overrides", () => {
    const p = deriveProfile(0, BASE, { stance: "meanrevert", phaseFracQ9: 123_000_000n });
    expect(p.stance).toBe("meanrevert"); // slot 0 would be momentum without the pin
    expect(p.phaseFracQ9).toBe(123_000_000n);
  });
});

describe("triangleQ9", () => {
  const P = 1000n;
  it("is -1 at the cycle start, +1 at the midpoint, and crosses zero at the quarters", () => {
    expect(triangleQ9(0n, P, 0n)).toBe(-Q9);
    expect(triangleQ9(P / 2n, P, 0n)).toBe(Q9);
    expect(triangleQ9(P / 4n, P, 0n)).toBe(0n);
    expect(triangleQ9((3n * P) / 4n, P, 0n)).toBe(0n);
  });
  it("is periodic", () => {
    expect(triangleQ9(37n, P, 0n)).toBe(triangleQ9(37n + P, P, 0n));
    expect(triangleQ9(37n, P, 0n)).toBe(triangleQ9(37n + 10n * P, P, 0n));
  });
  it("stays within [-Q9, Q9]", () => {
    for (let t = 0n; t < P; t += 7n) {
      const v = triangleQ9(t, P, 0n);
      expect(v >= -Q9 && v <= Q9).toBe(true);
    }
  });
});

describe("oscTarget", () => {
  const P = 600_000;
  it("makes momentum and mean-revert exact opposites at the same phase", () => {
    const mom = deriveProfile(0, BASE, { stance: "momentum", phaseFracQ9: 0n, periodMs: BigInt(P) });
    const rev = deriveProfile(0, BASE, { stance: "meanrevert", phaseFracQ9: 0n, periodMs: BigInt(P) });
    // sample across a full period; whenever one is long the other is short
    let sawLongShort = false;
    let sawShortLong = false;
    for (let t = 0; t < P; t += P / 40) {
      const a = oscTarget(t, mom);
      const b = oscTarget(t, rev);
      if (a !== "flat" && b !== "flat") expect(a).not.toBe(b);
      if (a === "long" && b === "short") sawLongShort = true;
      if (a === "short" && b === "long") sawShortLong = true;
    }
    expect(sawLongShort).toBe(true);
    expect(sawShortLong).toBe(true);
  });

  it("spends the cycle roughly half long and half short (two-sided flow)", () => {
    const p = deriveProfile(0, BASE, { phaseFracQ9: 0n, periodMs: BigInt(P) });
    let longs = 0;
    let shorts = 0;
    for (let t = 0; t < P; t += P / 200) {
      const tgt = oscTarget(t, p);
      if (tgt === "long") longs++;
      else if (tgt === "short") shorts++;
    }
    // near-balanced (band trims a little symmetrically around each zero-crossing)
    expect(Math.abs(longs - shorts)).toBeLessThan(10);
    expect(longs).toBeGreaterThan(50);
    expect(shorts).toBeGreaterThan(50);
  });
});
