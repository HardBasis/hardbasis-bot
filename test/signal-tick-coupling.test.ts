import { describe, it, expect } from "vitest";
import { Strategy } from "../src/strategy.ts";

// Why this file exists.
//
// The fleet stopped trading on testnet for days while every existing test was
// green. All four bots sat at the -2000 short cap logging
//   {"msg":"no order this tick","reason":"at position cap on desired side",
//    "target":"short","position":"-2000"}
// and `target` was "short" in 7,303 of 7,303 log samples over the full two-day
// retention. It had latched and could never let go.
//
// The bug was not in signal.ts — step() is correct, and test/signal.test.ts
// proves it by calling step() directly. The bug was in the WIRING: Strategy
// advanced the EMA from the ws price handler, once per price frame. Frames
// arrive at whatever rate the venue pushes (measured 1,415 frames in 10 min =
// 2.36/s on testnet), so with alpha = 1/32 the "slow EMA" the design calls for
// had a time constant of ~14 SECONDS instead of 32 ticks (8 minutes). A 14s EMA
// tracks the mid almost exactly, the deviation never breaches the +/-30bps
// hysteresis band, and since step() only ever assigns "long" or "short" (never
// back to "flat") whatever it first latched onto became permanent.
//
// Testing step() in isolation cannot catch that, and testing a hand-copied
// mirror of the loop cannot either. These tests drive the REAL Strategy, so the
// call-site wiring itself is under test.

const MARKET = {
  marketId: "btc-usd",
  status: "open",
  oracleFeedId: "btc-usd",
  minOrderContracts: "1",
  maxOrderContracts: "100000",
  tickSizeQ8: "100000",
  lastPrice: null,
};

const ok = <T,>(body: T) => ({ ok: true, status: 200, code: null, body }) as never;

interface Seen {
  side: string;
  contracts: string;
}

/** Strategy also exercises the conditional-order surface (stop / take-profit /
 * bracket) every 8th tick. Those are surface probes, not signal decisions, and
 * they use BOTH sides regardless of the target — counting them would make a
 * "does it take both sides?" assertion pass no matter what the signal did.
 * Only plain market orders with no trigger are trading decisions. */
const isTradingOrder = (b: { type?: string; trigger?: unknown }) =>
  b.type === "market" && b.trigger === undefined;

/** Build a Strategy over fakes. Position is held flat, so every tick that has a
 * long/short target places an order whose SIDE reveals that target, and a flat
 * target places nothing — which is how these tests observe the private signal
 * without reaching into it. */
function harness() {
  const placed: Seen[] = [];
  const noOrder: string[] = [];
  let probes = 0;
  const api = {
    markets: async () => ok([MARKET]),
    positions: async () => ok([]), // always flat
    cancelAllAfter: async () => ok({}),
    placeOrder: async (
      _k: string,
      b: { side: string; contracts: string; type?: string; trigger?: unknown },
    ) => {
      if (isTradingOrder(b)) placed.push({ side: b.side, contracts: b.contracts });
      probes++;
      return ok({ orderId: `o${probes}`, status: "accepted" });
    },
    orders: async () => ok({ items: [] }),
    cancelOrder: async () => ok({}),
    fills: async () => ok({ items: [] }),
    getOrder: async () => ok({}),
  };
  const cfg = {
    orderContracts: 500n,
    maxPositionContracts: 2000n,
    maxDailyTurnoverContracts: 200_000n,
    deadmanMs: 60_000,
    tickMs: 15_000,
  };
  const log = {
    debug: (msg: string, f?: Record<string, unknown>) => {
      if (msg === "no order this tick") noOrder.push(String(f?.reason));
    },
    info: () => {},
    warn: () => {},
    error: () => {},
    finding: () => {},
  };
  const state = { tradeKey: "k_test" };
  const store = { save: async () => {} };
  const s = new Strategy(
    api as never,
    cfg as never,
    state as never,
    store as never,
    log as never,
    () => 1_700_000_000_000,
  );
  return { s, placed, noOrder };
}

/** Drive one trading tick per entry of `perTick`. Before each tick, `filler`
 * extra frames of unrelated noise are delivered first, so the mid the tick
 * actually sees is always perTick[t] — only the frame COUNT differs between
 * runs. A tick-driven signal is identical across every filler value; a
 * frame-driven one is not. */
async function run(perTick: bigint[], filler: number) {
  const h = harness();
  await h.s.init();
  for (let t = 0; t < perTick.length; t++) {
    const mid = perTick[t]!;
    for (let f = 0; f < filler; f++) {
      // noise that must be discarded: alternating +/-2% spikes
      h.s.onMid(f % 2 === 0 ? (mid * 102n) / 100n : (mid * 98n) / 100n);
    }
    h.s.onMid(mid);
    await h.s.tick();
  }
  return h;
}

/** Drive a realistic feed: one value per FRAME, ticking every `framesPerTick`
 * frames — exactly how production runs. No synthetic spikes, so the EMA is not
 * whipped by anything the real venue would not send. */
async function runPath(framePath: bigint[], framesPerTick: number) {
  const h = harness();
  await h.s.init();
  for (let i = 0; i < framePath.length; i++) {
    h.s.onMid(framePath[i]!);
    if ((i + 1) % framesPerTick === 0) await h.s.tick();
  }
  return h;
}

// A price path that rises then falls by ~1.5% — far outside the 30bps band, so
// a correctly-tuned signal MUST take both sides of it.
function sawtooth(len: number, base = 7_800_000_000_000n, ampBps = 150n): bigint[] {
  const out: bigint[] = [];
  const half = Math.floor(len / 2);
  for (let i = 0; i < len; i++) {
    const up = i < half ? BigInt(i) : BigInt(len - i);
    out.push(base + (base * ampBps * up) / (10_000n * BigInt(half)));
  }
  return out;
}

describe("the signal is driven by the trading tick, not the venue's frame rate", () => {
  it("advances the EMA exactly once per tick regardless of how many frames arrive", async () => {
    // The SAME per-tick price path, but one run gets 35 extra noise frames
    // between ticks (the production rate) and the other gets none. The venue's
    // chattiness must not change a single decision.
    const path = sawtooth(60);
    const sides = (h: Awaited<ReturnType<typeof run>>) => h.placed.map((p) => p.side).join(",");

    const quiet = await run(path, 0);
    const chatty = await run(path, 35);
    const chattier = await run(path, 200);

    expect(sides(chatty)).toBe(sides(quiet));
    expect(sides(chattier)).toBe(sides(quiet));
    // and the path is genuinely two-sided, so this is not vacuously equal
    expect(new Set(quiet.placed.map((p) => p.side)).size).toBe(2);
  });

  it("onMid does not decide anything on its own — 1000 frames and no tick trade nothing", async () => {
    const h = harness();
    await h.s.init();
    for (const m of sawtooth(1000)) h.s.onMid(m);
    expect(h.placed).toHaveLength(0);
  });

  it("does not latch: over a smooth two-sided path the target takes BOTH sides", async () => {
    // THE PRODUCTION FAILURE, PINNED. A smooth 1.5% round trip delivered at the
    // rate measured on testnet: 35 frames per 15s tick, 60 ticks. Nothing here
    // is spiky — this is what a real oracle feed looks like.
    //
    // Pre-fix, the per-frame EMA glued itself to a path this smooth, the
    // deviation never reached the 30bps band, the target never left "flat",
    // and the bot placed NOTHING. (On the live venue it had already latched
    // "short" and sat at the cap instead.) Post-fix the tick-sampled EMA lags
    // properly and the bot works both sides.
    const FRAMES_PER_TICK = 35;
    const h = await runPath(sawtooth(60 * FRAMES_PER_TICK), FRAMES_PER_TICK);

    const sides = new Set(h.placed.map((p) => p.side));
    expect(h.placed.length).toBeGreaterThan(0);
    expect(sides.has("buy")).toBe(true);
    expect(sides.has("sell")).toBe(true);
  });

  it("skips cleanly before any mid has arrived", async () => {
    const h = harness();
    await h.s.init();
    await h.s.tick();
    expect(h.placed).toHaveLength(0);
  });
});
