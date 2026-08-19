import { describe, it, expect } from "vitest";
import type { TriggerSummary } from "../src/types.ts";

// PERF-TRIAGE-2026-08-19 (hardbasis-perp): a MARKET-entry bracket's protective
// legs activate when the entry fills, and cancelling the entry id afterwards
// does not reach them. Two leaked resting triggers per exercise cycle took
// testnet to 51,734 on one market against a 20-per-market cap, pinned the
// engine's event loop, and — once the venue enforced the cap at placement —
// stopped the fleet trading at all.
//
// The sweep's whole correctness rests on one distinction: a bracket leg carries
// an ocoGroup, a standalone trigger does not. reduceOnly cannot be used, because
// the trigger the drill deliberately keeps resting is reduce-only too
// (the venue derives reduce_only from kind: anything that is not "entry").

const LEG_SWEEP_MAX = 8;

/** The selection the sweep performs, extracted so it is testable without a
 * live venue. Mirrors Strategy.sweepBracketLegs. */
export function legsToSweep(triggers: TriggerSummary[], max = LEG_SWEEP_MAX): string[] {
  const out: string[] = [];
  for (const t of triggers) {
    if (t.ocoGroup === null) continue;
    if (out.length >= max) break;
    out.push(t.orderId);
  }
  return out;
}

const trig = (id: string, ocoGroup: string | null, kind: TriggerSummary["kind"]): TriggerSummary => ({
  orderId: id,
  marketId: "btc-usd",
  kind,
  side: "sell",
  contracts: "1",
  reduceOnly: kind !== "entry",
  status: "resting",
  reason: null,
  ocoGroup,
});

describe("bracket-leg sweep selection", () => {
  it("sweeps bracket legs and spares the standalone trigger the deadman drill keeps", () => {
    const kept = trig("t-standalone", null, "stop"); // reduce-only, but NOT a leg
    const legs = [trig("bk1:s", "bk1", "stop"), trig("bk1:t", "bk1", "take_profit")];
    expect(legsToSweep([kept, ...legs])).toEqual(["bk1:s", "bk1:t"]);
  });

  it("reduceOnly alone would be wrong — the kept trigger is reduce-only too", () => {
    const kept = trig("t-standalone", null, "stop");
    expect(kept.reduceOnly).toBe(true); // the trap this test exists to pin
    expect(legsToSweep([kept])).toEqual([]);
  });

  it("never sweeps an entry trigger (no ocoGroup, not reduce-only)", () => {
    expect(legsToSweep([trig("t-entry", null, "entry")])).toEqual([]);
  });

  it("is bounded per cycle so a backlog drains instead of bursting", () => {
    const many = Array.from({ length: 40 }, (_, i) => trig(`bk${i}:s`, `bk${i}`, "stop"));
    const swept = legsToSweep(many);
    expect(swept).toHaveLength(LEG_SWEEP_MAX);
    // and it makes progress: two legs are created per cycle, so >2 per sweep
    // means an existing backlog shrinks rather than merely holding station
    expect(LEG_SWEEP_MAX).toBeGreaterThan(2);
  });

  it("an empty or leg-free book is a no-op", () => {
    expect(legsToSweep([])).toEqual([]);
    expect(legsToSweep([trig("a", null, "take_profit")])).toEqual([]);
  });
});
