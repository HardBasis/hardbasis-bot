/**
 * The trading loop. A small oscillating position on the venue's first market,
 * driven by the oracle-stream signal, sized under self-enforced caps. It also:
 *  - exercises the conditional-order surface (stop / take-profit / bracket) and
 *    cancels most of them,
 *  - keeps cancel-all-after armed and refreshed, and deliberately lets it fire
 *    once per install to prove the dead-man's-switch in production (#7),
 *  - runs the precision scan (#3) over every order/fill it sees.
 *
 * Coverage and endurance, not alpha (per the request).
 */
import type { Api } from "./api.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { BotState } from "./state.ts";
import type { Store } from "./state.ts";
import type { PlaceOrderBody, PublicMarket, Position, TriggerSummary } from "./types.ts";
import { decideOrder } from "./sizing.ts";
import { initSignal, step, type SignalState, type Target } from "./signal.ts";
import { scanForFloatMoney } from "./invariants.ts";
import { Q8 } from "./money.ts";

/** Bracket legs cancelled per cycle. Two are created per exercise, so anything
 * above 2 drains a backlog while staying gentle on the A4 velocity limits. */
const LEG_SWEEP_MAX = 8;

interface TurnoverEntry {
  tsMs: number;
  contracts: bigint;
}

export class Strategy {
  private signal: SignalState = initSignal();
  private turnover: TurnoverEntry[] = [];
  private ticks = 0;
  private market!: PublicMarket;
  private restingIds = new Set<string>();

  constructor(
    private api: Api,
    private cfg: Config,
    private state: BotState,
    private store: Store,
    private log: Logger,
    private now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {
    const r = await this.api.markets();
    const m = Array.isArray(r.body) ? r.body[0] : undefined;
    if (!m) throw new Error("no markets returned; cannot trade");
    this.market = m;
    this.log.info("trading market selected", { marketId: m.marketId, status: m.status, feedId: m.oracleFeedId });
  }

  marketId(): string {
    return this.market.marketId;
  }
  feedId(): string {
    return this.market.oracleFeedId;
  }

  /** Feed the signal from the oracle stream (called by the ws price handler). */
  onMid(midQ8: bigint): void {
    this.signal = step(this.signal, midQ8);
  }

  private turnoverContracts(): bigint {
    const cutoff = this.now() - 24 * 3600 * 1000;
    this.turnover = this.turnover.filter((e) => e.tsMs >= cutoff);
    return this.turnover.reduce((a, e) => a + e.contracts, 0n);
  }

  private async signedPosition(): Promise<bigint> {
    const r = await this.api.positions(this.state.tradeKey);
    const list = Array.isArray(r.body) ? (r.body as Position[]) : [];
    const p = list.find((x) => x.marketId === this.market.marketId);
    if (!p) return 0n;
    scanForFloatMoney(p, "position");
    const c = /^-?\d+$/.test(p.contracts) ? BigInt(p.contracts) : 0n;
    return p.side === "long" ? c : -c;
  }

  /** Keep the dead-man's-switch armed at the configured deadline. */
  async armDeadman(): Promise<void> {
    const r = await this.api.cancelAllAfter(this.state.tradeKey, this.cfg.deadmanMs.toString());
    if (!r.ok) this.log.warn("arm cancel-all-after failed", { status: r.status, code: r.code });
    else scanForFloatMoney(r.body, "cancel-all-after");
  }

  /** One trading step. */
  async tick(): Promise<void> {
    this.ticks++;
    if (this.signal.emaQ8 === null) {
      this.log.debug("no oracle mid yet; skipping tick");
      return;
    }
    await this.armDeadman();

    const position = await this.signedPosition();
    const decision = decideOrder({
      target: this.signal.target as Target,
      positionContracts: position,
      orderContracts: this.cfg.orderContracts,
      maxPositionContracts: this.cfg.maxPositionContracts,
      turnoverContracts: this.turnoverContracts(),
      maxDailyTurnoverContracts: this.cfg.maxDailyTurnoverContracts,
      minOrderContracts: big(this.market.minOrderContracts, 1n),
      maxOrderContracts: big(this.market.maxOrderContracts, this.cfg.orderContracts),
    });

    if (decision.side) {
      await this.placeMarket(decision.side, decision.contracts, position);
    } else {
      this.log.debug("no order this tick", { reason: decision.reason, target: this.signal.target, position: position.toString() });
    }

    // Every ~8th tick, exercise the conditional-order surface and cancel most.
    if (this.ticks % 8 === 0) await this.exerciseConditionals();
    // Every ~5th tick, scan a page of fills for precision.
    if (this.ticks % 5 === 0) await this.scanFills();
  }

  private async placeMarket(side: "buy" | "sell", contracts: bigint, positionBefore: bigint): Promise<void> {
    // reduceOnly when the order only shrinks an opposite position
    const reduceOnly = (side === "buy" && positionBefore < 0n) || (side === "sell" && positionBefore > 0n)
      ? absLte(contracts, positionBefore)
      : false;
    const body: PlaceOrderBody = { marketId: this.market.marketId, side, type: "market", contracts: contracts.toString(), reduceOnly };
    const r = await this.api.placeOrder(this.state.tradeKey, body);
    if (!r.ok) {
      this.log.warn("market order refused", { status: r.status, code: r.code, body: r.body, side, contracts: contracts.toString() });
      return;
    }
    scanForFloatMoney(r.body, "order-result");
    this.turnover.push({ tsMs: this.now(), contracts });
    this.log.info("placed market order", { side, contracts: contracts.toString(), orderId: r.body.orderId, status: r.body.status });
  }

  /** Round a price to the market tick (floor). Trigger levels MUST be
   * tick-aligned — an unaligned level returns a 500 "internal error" from the
   * gateway (SOAK-FINDINGS: unaligned trigger level should be a 400 validation,
   * not a 500), so the bot never sends one. */
  private alignToTick(priceQ8: bigint): bigint {
    const tick = big(this.market.tickSizeQ8, 1n);
    if (tick <= 0n) return priceQ8;
    return (priceQ8 / tick) * tick;
  }

  /** Place a stop, a take-profit, and a bracket far from mark, then cancel most. */
  private async exerciseConditionals(): Promise<void> {
    const mid = this.signal.emaQ8;
    if (mid === null) return;
    const far = mid / 5n; // 20% away — will not trigger; pure surface exercise
    const stop = this.alignToTick(mid - far).toString();
    const tp = this.alignToTick(mid + far).toString();
    const placed: string[] = [];

    const s = await this.api.placeOrder(this.state.tradeKey, {
      marketId: this.market.marketId,
      side: "sell",
      type: "stop_market",
      contracts: this.market.minOrderContracts,
      reduceOnly: false,
      trigger: { kind: "stop", level: stop },
    });
    if (s.ok) placed.push(s.body.orderId);
    else this.log.debug("stop trigger refused", { code: s.code, status: s.status });

    const t = await this.api.placeOrder(this.state.tradeKey, {
      marketId: this.market.marketId,
      side: "sell",
      type: "take_profit_market",
      contracts: this.market.minOrderContracts,
      reduceOnly: false,
      trigger: { kind: "take_profit", level: tp },
    });
    if (t.ok) placed.push(t.body.orderId);
    else this.log.debug("take-profit trigger refused", { code: t.code, status: t.status });

    const b = await this.api.placeOrder(this.state.tradeKey, {
      marketId: this.market.marketId,
      side: "buy",
      type: "market",
      contracts: this.market.minOrderContracts,
      reduceOnly: false,
      bracket: { entryKind: "market", stopLevel: stop, takeProfitLevel: tp },
    });
    if (b.ok) placed.push(b.body.orderId);
    else this.log.debug("bracket refused", { code: b.code, status: b.status });

    // Cancel most of what we placed (keep one resting for the deadman drill).
    for (const id of placed.slice(1)) {
      const c = await this.api.cancelOrder(this.state.tradeKey, id);
      if (c.ok) this.restingIds.delete(id);
    }
    if (placed[0]) this.restingIds.add(placed[0]);
    // …but cancelling the bracket's ENTRY id does not reach its protective
    // legs, so sweep those explicitly. Without this the exercise leaks two
    // resting triggers on every cycle, permanently.
    const swept = await this.sweepBracketLegs();
    this.log.info("exercised conditional-order surface", {
      placed: placed.length,
      legsSwept: swept,
    });
  }

  /**
   * Close-and-cancel hygiene for the bracket's protective legs.
   *
   * `exerciseConditionals` places a MARKET-entry bracket. The entry fills on the
   * next verified print, which ACTIVATES a stop and a take-profit (spec B2), and
   * cancelling the entry order id afterwards is a no-op for them — a bracket
   * cancel only tears down a bracket whose entry has not filled yet. The legs
   * then rest until the position closes, and this bot never closes its position.
   *
   * Two legs per cycle, forever: that is how testnet reached 51,734 resting
   * triggers on one market against a 20-per-market cap, and pinned the engine's
   * event loop reloading them on every print
   * (hardbasis-perp docs/requests/PERF-TRIAGE-2026-08-19.md). The venue now
   * enforces the cap at placement, so an un-swept fleet stops trading
   * altogether — the leak became a self-inflicted outage.
   *
   * A bracket leg is exactly a resting trigger carrying an `ocoGroup`; a
   * standalone stop/take-profit has none. That distinction is what lets this
   * sweep run without touching the trigger `exerciseConditionals` deliberately
   * keeps resting for the dead-man's-switch drill — which is also reduce-only,
   * so reduceOnly alone would not do.
   *
   * Bounded per cycle: cancels are order traffic under the venue's velocity
   * limits (spec A4), and a large backlog should drain over several cycles
   * rather than burst.
   */
  private async sweepBracketLegs(): Promise<number> {
    const r = await this.api.orders(this.state.tradeKey, {
      state: "resting",
      limit: String(LEG_SWEEP_MAX * 2),
    });
    if (!r.ok) {
      this.log.debug("leg sweep: could not list resting triggers", { status: r.status });
      return 0;
    }
    const triggers = (r.body as unknown as { triggers?: TriggerSummary[] }).triggers ?? [];
    let cancelled = 0;
    for (const t of triggers) {
      if (t.ocoGroup === null) continue; // standalone — not ours to sweep
      if (cancelled >= LEG_SWEEP_MAX) break;
      const c = await this.api.cancelOrder(this.state.tradeKey, t.orderId);
      if (c.ok) {
        this.restingIds.delete(t.orderId);
        cancelled++;
      } else {
        this.log.debug("leg sweep: cancel refused", { code: c.code, status: c.status });
      }
    }
    return cancelled;
  }

  private async scanFills(): Promise<void> {
    const r = await this.api.fills(this.state.tradeKey, undefined, "10");
    scanForFloatMoney(r.body, "fills");
  }

  /**
   * Invariant #7 — deliberately let cancel-all-after fire once and verify the
   * resting orders are cancelled within ~one sweep, with reason "deadman".
   */
  async deliberateDeadmanFire(): Promise<void> {
    if (this.state.deadmanFired) return;
    this.log.info("dead-man's-switch drill: arming a short deadline and NOT refreshing");
    // Place a resting LIMIT order far below mark (rests, won't fill) to be
    // cancelled. A limit order — NOT a trigger — because a trigger id is not
    // resolvable via GET /v1/orders/{id} (returns not_found; SOAK-FINDINGS), so
    // only a limit order can be polled by id to observe the sweep.
    const mid = this.signal.emaQ8 ?? BigInt(this.market.lastPrice?.midQ8 ?? Q8.toString());
    const limitPriceQ8 = this.alignToTick(mid / 2n).toString();
    const placed = await this.api.placeOrder(this.state.tradeKey, {
      marketId: this.market.marketId,
      side: "buy",
      type: "limit",
      contracts: this.market.minOrderContracts,
      limitPriceQ8,
      reduceOnly: false,
    });
    if (!placed.ok) {
      this.log.warn("deadman drill: could not place a resting order; skipping", { status: placed.status, code: placed.code, body: placed.body });
      return;
    }
    const restId = placed.body.orderId;
    const shortMs = 5000n;
    const arm = await this.api.cancelAllAfter(this.state.tradeKey, shortMs.toString());
    if (!arm.ok) {
      this.log.finding({
        kind: "invariant:deadman",
        summary: `cancel-all-after refused a ${shortMs}ms deadline (status ${arm.status}, code ${arm.code})`,
        evidence: { request: arm.request, body: arm.body },
      });
    }
    // Wait for expiry + a sweep interval, not refreshing.
    const deadline = this.now() + Number(shortMs) + 20_000;
    let cancelled = false;
    let reason: string | null = null;
    while (this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const o = await this.api.getOrder(this.state.tradeKey, restId);
      if (o.ok && (o.body.status === "canceled" || o.body.status === "rejected")) {
        cancelled = true;
        reason = o.body.reason;
        break;
      }
    }
    if (!cancelled) {
      this.log.finding({
        kind: "invariant:deadman",
        summary: `resting order ${restId} was NOT cancelled within one sweep after cancel-all-after expiry`,
        evidence: { orderId: restId },
      });
    } else if (reason !== "deadman") {
      // The switch fired (order cancelled) but the cancellation is not stamped
      // reason:"deadman" — a docs-vs-reality gap, not a functional failure.
      this.log.info("dead-man's-switch fired (order cancelled)", { orderId: restId, reason });
      this.log.finding({
        kind: "docs-vs-reality",
        summary: `dead-man's-switch cancelled the resting order but reason was ${JSON.stringify(reason)}, not "deadman" (invariant #7 expects reason:"deadman")`,
        evidence: { orderId: restId, reason },
      });
    } else {
      this.log.info("dead-man's-switch fired correctly", { orderId: restId, reason });
    }
    this.state.deadmanFired = true;
    this.store.save(this.state);
    // Re-arm normal protection.
    await this.armDeadman();
  }
}

function big(raw: string, dflt: bigint): bigint {
  return /^-?\d+$/.test(raw) ? BigInt(raw) : dflt;
}
function absLte(a: bigint, b: bigint): boolean {
  const aa = a < 0n ? -a : a;
  const bb = b < 0n ? -b : b;
  return aa <= bb;
}
