import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimSlot, renewSlot, slotStateDir, DEFAULT_LEASE_MS } from "../src/instance.ts";

// The defect these pin: state used to be keyed on the container id, so a
// `docker compose up` that recreates replicas gave each a fresh state dir, and
// a fresh state dir means the bot bootstraps a NEW account and draws the
// faucet. Two fleet recreates on 2026-08-19 minted six accounts and six grants,
// and one of those bursts false-halted deposits on the venue for 11 minutes.
//
// The property that matters is therefore not "slots are unique" — it is
// "same fleet size in, same slots out, across a recreate".

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hb-slots-"));
});

const claimFleet = (ids: string[], nowMs: number): number[] =>
  ids.map((id) => claimSlot(dir, 16, id, { nowMs }).slot);

describe("slot claiming", () => {
  it("gives concurrent replicas distinct ordinals from zero up", () => {
    expect(claimFleet(["c1", "c2", "c3"], 1_000)).toEqual([0, 1, 2]);
  });

  it("a plain restart reclaims its own slot by id", () => {
    expect(claimSlot(dir, 16, "c1", { nowMs: 1_000 }).slot).toBe(0);
    const again = claimSlot(dir, 16, "c1", { nowMs: 2_000 });
    expect(again.slot).toBe(0);
    expect(again.tookOver).toBe(false);
  });

  it("RECREATE: new container ids inherit the old slots once the leases go stale", () => {
    // three replicas run, then their containers are destroyed
    expect(claimFleet(["old-a", "old-b", "old-c"], 1_000)).toEqual([0, 1, 2]);
    // …nothing renews the leases; a recreate starts three NEW container ids
    const later = 1_000 + DEFAULT_LEASE_MS + 1;
    const fresh = ["new-a", "new-b", "new-c"].map((id) => claimSlot(dir, 16, id, { nowMs: later }));
    // same three slots, so the same three state dirs, so the same three accounts
    expect(fresh.map((c) => c.slot).sort()).toEqual([0, 1, 2]);
    expect(fresh.every((c) => c.tookOver)).toBe(true);
  });

  it("a LIVE holder is never evicted — renewing keeps the slot", () => {
    expect(claimSlot(dir, 16, "live", { nowMs: 1_000 }).slot).toBe(0);
    // it keeps renewing across the window
    for (let t = 1_000; t < 1_000 + DEFAULT_LEASE_MS * 3; t += DEFAULT_LEASE_MS / 4) {
      expect(renewSlot(dir, 0, "live", t)).toBe(true);
    }
    const late = 1_000 + DEFAULT_LEASE_MS * 3;
    // a newcomer must NOT take slot 0 — it is still being renewed
    expect(claimSlot(dir, 16, "newcomer", { nowMs: late }).slot).toBe(1);
  });

  it("renewSlot is a no-op once another instance has taken the slot over", () => {
    claimSlot(dir, 16, "old", { nowMs: 1_000 });
    claimSlot(dir, 16, "new", { nowMs: 1_000 + DEFAULT_LEASE_MS + 1 });
    // the evicted holder must learn it lost, not keep stamping someone's lease
    expect(renewSlot(dir, 0, "old", 2_000_000)).toBe(false);
    expect(readFileSync(join(dir, "slot-0.lock"), "utf8")).toContain("new");
  });

  it("two replicas racing for the SAME stale slot do not both get it", () => {
    claimFleet(["old-a", "old-b"], 1_000);
    const later = 1_000 + DEFAULT_LEASE_MS + 1;
    const a = claimSlot(dir, 16, "new-a", { nowMs: later });
    const b = claimSlot(dir, 16, "new-b", { nowMs: later });
    expect(a.slot).not.toBe(b.slot);
  });

  it("falls back deterministically when every slot has a LIVE holder", () => {
    claimFleet(["a", "b"], 1_000);
    const c = claimSlot(dir, 2, "c", { nowMs: 1_100 }); // maxSlots=2, both live
    expect(c.exhausted).toBe(true);
    expect(c.slot).toBe(2);
  });

  it("survives a corrupt or empty lock file rather than crashing the bot", () => {
    writeFileSync(join(dir, "slot-0.lock"), "");
    const c = claimSlot(dir, 16, "x", { nowMs: 10_000_000 });
    expect(existsSync(join(dir, "slot-0.lock"))).toBe(true);
    expect(typeof c.slot).toBe("number");
  });
});

describe("state directory follows the slot, not the container", () => {
  it("the same slot yields the same state dir for any container id", () => {
    expect(slotStateDir("/app/state", 0)).toBe("/app/state/slot-0");
    expect(slotStateDir("/app/state", 2)).toBe("/app/state/slot-2");
  });

  it("across a recreate, every replica lands on a state dir that already exists", () => {
    const before = claimFleet(["old-a", "old-b", "old-c"], 1_000).map((s) =>
      slotStateDir("/app/state", s),
    );
    const later = 1_000 + DEFAULT_LEASE_MS + 1;
    const after = ["new-a", "new-b", "new-c"]
      .map((id) => claimSlot(dir, 16, id, { nowMs: later }).slot)
      .map((s) => slotStateDir("/app/state", s));
    // set-equal: the fleet reoccupies exactly the directories it left behind,
    // which is what makes the recreate draw zero faucet grants
    expect(after.sort()).toEqual(before.sort());
  });
});
