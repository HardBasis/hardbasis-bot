import { describe, it, expect } from "vitest";
import { initSignal, step } from "../src/signal.ts";

const M = 10_000_000_000n; // $100.00 in q8

describe("signal", () => {
  it("seeds the EMA on the first mid and stays flat", () => {
    const s = step(initSignal(), M);
    expect(s.emaQ8).toBe(M);
    expect(s.target).toBe("flat");
  });

  it("goes long when mid runs above the slow line beyond the band", () => {
    let s = step(initSignal(), M);
    s = step(s, M + M / 10n); // +10% jump
    expect(s.target).toBe("long");
  });

  it("flips short when mid falls well below the slow line", () => {
    let s = step(initSignal(), M);
    s = step(s, M + M / 10n);
    expect(s.target).toBe("long");
    for (let i = 0; i < 10; i++) s = step(s, M - M / 5n); // sustained -20%
    expect(s.target).toBe("short");
  });

  it("holds inside the band (hysteresis, no chatter)", () => {
    let s = step(initSignal(), M);
    // a 1 bps wiggle (< 30 bps band) must not move the target off flat
    s = step(s, M + M / 100000n);
    expect(s.target).toBe("flat");
  });

  it("keeps the EMA as an exact bigint — no float ever", () => {
    let s = step(initSignal(), M);
    s = step(s, M + 12345n);
    expect(typeof s.emaQ8).toBe("bigint");
  });
});
