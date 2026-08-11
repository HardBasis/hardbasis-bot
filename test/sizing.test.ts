import { describe, it, expect } from "vitest";
import { decideOrder, type SizingInput } from "../src/sizing.ts";

const base: SizingInput = {
  target: "long",
  positionContracts: 0n,
  orderContracts: 500n,
  maxPositionContracts: 2000n,
  turnoverContracts: 0n,
  maxDailyTurnoverContracts: 200000n,
  minOrderContracts: 1n,
  maxOrderContracts: 100000n,
};

describe("decideOrder", () => {
  it("does nothing when flat", () => {
    expect(decideOrder({ ...base, target: "flat" }).side).toBeNull();
  });

  it("opens toward the target from flat", () => {
    const d = decideOrder(base);
    expect(d.side).toBe("buy");
    expect(d.contracts).toBe(500n);
  });

  it("sells to open a short", () => {
    expect(decideOrder({ ...base, target: "short" }).side).toBe("sell");
  });

  it("holds at the position cap on the desired side", () => {
    const d = decideOrder({ ...base, positionContracts: 2000n });
    expect(d.side).toBeNull();
    expect(d.reason).toMatch(/cap/);
  });

  it("stops trading when the daily turnover cap is hit", () => {
    const d = decideOrder({ ...base, turnoverContracts: 200000n });
    expect(d.side).toBeNull();
    expect(d.reason).toMatch(/turnover/);
  });

  it("clamps the order to the remaining turnover headroom", () => {
    const d = decideOrder({ ...base, turnoverContracts: 199800n });
    expect(d.contracts).toBe(200n);
  });

  it("flips from short toward long", () => {
    const d = decideOrder({ ...base, target: "long", positionContracts: -1000n });
    expect(d.side).toBe("buy");
    expect(d.contracts).toBe(500n);
  });

  it("respects the market minimum order size", () => {
    const d = decideOrder({ ...base, orderContracts: 500n, minOrderContracts: 1000n });
    expect(d.contracts).toBe(1000n);
  });

  it("holds when the remaining gap is below the market minimum", () => {
    const d = decideOrder({ ...base, positionContracts: 1999n, minOrderContracts: 1000n });
    expect(d.side).toBeNull();
  });

  it("never exceeds the market max order size", () => {
    const d = decideOrder({ ...base, orderContracts: 100000n, maxOrderContracts: 750n, maxPositionContracts: 100000n });
    expect(d.contracts).toBe(750n);
  });
});
