/**
 * Instance identity + slot claiming — what makes `docker compose up -d
 * --scale trader=N` behave as N distinct, cooperating bots rather than N copies
 * fighting over one state file and one account.
 *
 * Two orthogonal notions:
 *
 *  - **instanceId** — a stable label for THIS container. It keys the per-instance
 *    state directory (which holds a 0600 key) and log directory, and tags every
 *    log line. `HB_INSTANCE_ID` if set, else the container hostname (Docker sets
 *    it to the container id, unique per replica; a plain `docker restart` keeps
 *    the same id, so a restart reuses the same account — only a recreate churns).
 *
 *  - **slot** — a small ordinal (0,1,2,…) claimed atomically from a directory
 *    SHARED by all replicas of a service (the shared state volume). The slot is
 *    NOT identity — it seeds decorrelation (stance/phase/period/size) and the
 *    signup stagger, so slot 0 and slot 1 are guaranteed to differ. The claim is
 *    a single `open(O_CREAT|O_EXCL)`, so two replicas racing can never take the
 *    same slot. A replica that already holds a slot (a restart) reclaims it.
 */
import { openSync, writeSync, closeSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Resolve this container's stable instance id (env override, else hostname). */
export function resolveInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.HB_INSTANCE_ID ?? "").trim();
  return explicit !== "" ? explicit : hostname();
}

/** Make an instance id safe as a single path segment (state/log subdir name). */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 64);
  return cleaned === "" ? "instance" : cleaned;
}

export interface SlotClaim {
  slot: number;
  /** true when the ordinal ran past maxSlots and had to fall back (all taken). */
  exhausted: boolean;
}

/**
 * Claim a slot ordinal in [0, maxSlots). Restart-stable: if this instance
 * already owns a slot file, reuse it; otherwise take the lowest free ordinal
 * with an atomic exclusive create. Slot files are intentionally never deleted —
 * they mark a claimed ordinal; leakage across recreates is bounded by the number
 * of recreates and guarded by maxSlots (default is generous for the hardware).
 */
export function claimSlot(slotsDir: string, maxSlots: number, instanceId: string): SlotClaim {
  mkdirSync(slotsDir, { recursive: true });

  // Reclaim our own slot first (a plain restart re-runs this with the same id).
  for (let n = 0; n < maxSlots; n++) {
    const p = join(slotsDir, `slot-${n}.lock`);
    if (existsSync(p)) {
      try {
        if (readFileSync(p, "utf8").trim() === instanceId) return { slot: n, exhausted: false };
      } catch {
        /* unreadable lock — treat as owned by someone else, keep scanning */
      }
    }
  }

  // Otherwise take the lowest free ordinal. O_EXCL makes the winner unambiguous.
  for (let n = 0; n < maxSlots; n++) {
    const p = join(slotsDir, `slot-${n}.lock`);
    try {
      const fd = openSync(p, "wx");
      try {
        writeSync(fd, instanceId + "\n");
      } finally {
        closeSync(fd);
      }
      return { slot: n, exhausted: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
  }

  // Every ordinal is taken (more live instances than maxSlots). Fall back to the
  // ceiling: a valid, deterministic profile — decorrelation degrades but the
  // instance still runs and its identity/state are unaffected.
  return { slot: maxSlots, exhausted: true };
}
