/**
 * Instance identity + slot claiming — what makes `docker compose up -d
 * --scale trader=N` behave as N distinct, cooperating bots rather than N copies
 * fighting over one state file and one account.
 *
 * Two orthogonal notions:
 *
 *  - **instanceId** — a label for THIS container: `HB_INSTANCE_ID` if set, else
 *    the container hostname. It tags log lines. It does NOT key state — see
 *    below.
 *
 *  - **slot** — a small ordinal (0,1,2,…) claimed from a directory SHARED by all
 *    replicas of a service (the shared state volume). It seeds decorrelation
 *    (stance/phase/period/size) and the signup stagger, so slot 0 and slot 1 are
 *    guaranteed to differ — AND it keys the per-instance state directory.
 *
 * State is keyed on the SLOT, not the instance id, and slots are held on a
 * renewable LEASE. That is a correction, not a preference:
 *
 *   Docker sets the hostname to the container id, so keying state on the
 *   instance id meant a `docker compose up` that recreates containers gave every
 *   replica a fresh state directory. A fresh state directory means the bot
 *   bootstraps a NEW account and draws the faucet. On 2026-08-19 two fleet
 *   recreates minted six accounts and six grants, and one of those grant bursts
 *   false-halted deposits on the venue for eleven minutes
 *   (hardbasis-perp docs/requests/SOLV-ATOMIC-RECON.md). The old comment here
 *   called that out — "only a recreate churns" — as if churn were survivable. It
 *   is not: it is unbounded account creation triggered by a routine deploy.
 *
 *   So a slot is now a lease: its lock file carries the holder and a heartbeat.
 *   A restart reclaims its own slot by id (as before). A RECREATE finds the old
 *   holders' leases stale — their containers are gone, so nothing renews them —
 *   and takes them over, inheriting the slot's state directory and therefore its
 *   existing account. Same fleet size in, same accounts out, zero signups.
 */
import {
  openSync,
  writeSync,
  closeSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
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
  /** true when this slot was taken over from a holder whose lease went stale. */
  tookOver: boolean;
}

interface Lease {
  holder: string;
  heartbeatMs: number;
}

/** A lease is stale when nothing has renewed it for `leaseMs`. Sized well above
 * the renew interval so a merely busy instance is never evicted: the renew runs
 * every tick, so several missed ticks are needed. */
export const DEFAULT_LEASE_MS = 120_000;

function readLease(path: string): Lease | null {
  try {
    const raw = readFileSync(path, "utf8");
    const [holder = "", beat = ""] = raw.split("\n");
    const heartbeatMs = Number(beat.trim());
    return { holder: holder.trim(), heartbeatMs: Number.isFinite(heartbeatMs) ? heartbeatMs : 0 };
  } catch {
    return null;
  }
}

function writeLease(path: string, holder: string, nowMs: number): void {
  // temp + rename so a reader never sees a half-written lease
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${holder}\n${String(nowMs)}\n`);
  renameSync(tmp, path);
}

/** Renew this instance's lease. Call on the loop tick; a no-op if another
 * instance has since taken the slot over (we lost it and must not stamp it). */
export function renewSlot(
  slotsDir: string,
  slot: number,
  instanceId: string,
  nowMs: number = Date.now(),
): boolean {
  const p = join(slotsDir, `slot-${slot}.lock`);
  const lease = readLease(p);
  if (lease === null || lease.holder !== instanceId) return false;
  writeLease(p, instanceId, nowMs);
  return true;
}

/**
 * Claim a slot ordinal in [0, maxSlots). Restart-stable: if this instance
 * already owns a slot file, reuse it; otherwise take the lowest free ordinal
 * with an atomic exclusive create. Slot files are intentionally never deleted —
 * they mark a claimed ordinal; leakage across recreates is bounded by the number
 * of recreates and guarded by maxSlots (default is generous for the hardware).
 */
export function claimSlot(
  slotsDir: string,
  maxSlots: number,
  instanceId: string,
  opts: { leaseMs?: number; nowMs?: number } = {},
): SlotClaim {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const nowMs = opts.nowMs ?? Date.now();
  mkdirSync(slotsDir, { recursive: true });

  // 1. Reclaim our own slot (a plain restart re-runs this with the same id).
  for (let n = 0; n < maxSlots; n++) {
    const lease = readLease(join(slotsDir, `slot-${n}.lock`));
    if (lease !== null && lease.holder === instanceId) {
      writeLease(join(slotsDir, `slot-${n}.lock`), instanceId, nowMs);
      return { slot: n, exhausted: false, tookOver: false };
    }
  }

  // 2. Take over the lowest slot whose lease has gone STALE — BEFORE taking a
  //    fresh ordinal. This is the recreate path, and the order is the whole
  //    point: with maxSlots well above the fleet size there are always free
  //    ordinals, so preferring a free one would walk the fleet up the range on
  //    every recreate (0,1,2 → 3,4,5 → …) and abandon a state directory — and
  //    therefore an account — each time. Inheriting a dead holder's slot is
  //    what makes a recreate cost zero signups. Write-then-reread is a
  //    compare-and-swap: if two replicas race for the same stale slot, only the
  //    one whose id survives the reread keeps it; the loser moves on.
  for (let n = 0; n < maxSlots; n++) {
    const p = join(slotsDir, `slot-${n}.lock`);
    const lease = readLease(p);
    if (lease === null || nowMs - lease.heartbeatMs < leaseMs) continue;
    writeLease(p, instanceId, nowMs);
    if (readLease(p)?.holder === instanceId) return { slot: n, exhausted: false, tookOver: true };
  }

  // 3. Nothing stale to inherit — take the lowest FREE ordinal (first boot, or
  //    a genuine scale-up). O_EXCL makes the winner unambiguous.
  for (let n = 0; n < maxSlots; n++) {
    const p = join(slotsDir, `slot-${n}.lock`);
    try {
      const fd = openSync(p, "wx");
      try {
        writeSync(fd, `${instanceId}\n${String(nowMs)}\n`);
      } finally {
        closeSync(fd);
      }
      return { slot: n, exhausted: false, tookOver: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
  }

  // 4. Every ordinal is taken by a LIVE holder (more replicas than maxSlots).
  //    Fall back to the ceiling: a valid, deterministic profile — decorrelation
  //    degrades but the instance still runs.
  return { slot: maxSlots, exhausted: true, tookOver: false };
}

/** Where a slot's state lives. Keyed on the SLOT so a recreate — which changes
 * the container id but not the slot — reuses the same account. */
export function slotStateDir(baseStateDir: string, slot: number): string {
  return join(baseStateDir, `slot-${String(slot)}`);
}
