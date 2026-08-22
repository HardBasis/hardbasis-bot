import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimSlot, sanitizeId, resolveInstanceId } from "../src/instance.ts";

const tmps: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hb-slots-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sanitizeId", () => {
  it("keeps safe path chars and replaces the rest", () => {
    expect(sanitizeId("a1b2c3")).toBe("a1b2c3");
    expect(sanitizeId("auditor")).toBe("auditor");
    expect(sanitizeId("foo/bar baz")).toBe("foo_bar_baz");
    expect(sanitizeId("../etc")).toBe("__etc"); // "/" → "_", leading ".." → "_"
  });
  it("never yields an empty or dot-leading segment", () => {
    expect(sanitizeId("")).toBe("instance");
    expect(sanitizeId("...")[0]).not.toBe(".");
  });
});

describe("resolveInstanceId", () => {
  it("prefers HB_INSTANCE_ID when set", () => {
    expect(resolveInstanceId({ HB_INSTANCE_ID: "trader-x" } as NodeJS.ProcessEnv)).toBe("trader-x");
  });
  it("falls back to the hostname when unset/blank", () => {
    const id = resolveInstanceId({ HB_INSTANCE_ID: "" } as NodeJS.ProcessEnv);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("claimSlot", () => {
  it("hands distinct ordinals to distinct instances (no collision)", () => {
    const dir = freshDir();
    expect(claimSlot(dir, 16, "container-aaa")).toEqual({ slot: 0, exhausted: false, tookOver: false });
    expect(claimSlot(dir, 16, "container-bbb")).toEqual({ slot: 1, exhausted: false, tookOver: false });
    expect(claimSlot(dir, 16, "container-ccc")).toEqual({ slot: 2, exhausted: false, tookOver: false });
  });

  it("reclaims the same slot for the same instance (restart-stable)", () => {
    const dir = freshDir();
    expect(claimSlot(dir, 16, "container-aaa").slot).toBe(0);
    expect(claimSlot(dir, 16, "container-bbb").slot).toBe(1);
    // container-aaa restarts: it must get slot 0 back, not a fresh ordinal
    expect(claimSlot(dir, 16, "container-aaa").slot).toBe(0);
    // and a genuinely new instance takes the next free ordinal
    expect(claimSlot(dir, 16, "container-ddd").slot).toBe(2);
  });

  it("reports exhaustion when every ordinal is taken", () => {
    const dir = freshDir();
    expect(claimSlot(dir, 2, "a").slot).toBe(0);
    expect(claimSlot(dir, 2, "b").slot).toBe(1);
    const c = claimSlot(dir, 2, "c");
    expect(c).toEqual({ slot: 2, exhausted: true, tookOver: false });
  });
});
