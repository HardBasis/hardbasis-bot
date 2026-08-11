/**
 * Order sizing and self-limiting caps. Pure integer (contracts) arithmetic.
 *
 * The bot never lets its |position| exceed maxPositionContracts, never trades
 * more than maxDailyTurnoverContracts in a rolling 24h, and clamps every order
 * to the market's min/max order size. These caps are the "self-limiting by
 * default" the request asks for; they are unit-tested so a cap can never
 * silently regress.
 */
export interface SizingInput {
  target: "long" | "short" | "flat";
  /** signed current position, contracts (+long / -short) */
  positionContracts: bigint;
  orderContracts: bigint;
  maxPositionContracts: bigint;
  /** contracts already traded in the rolling window */
  turnoverContracts: bigint;
  maxDailyTurnoverContracts: bigint;
  /** market bounds */
  minOrderContracts: bigint;
  maxOrderContracts: bigint;
}

export interface SizingDecision {
  side: "buy" | "sell" | null;
  contracts: bigint;
  reason: string;
}

const NONE: Omit<SizingDecision, "reason"> = { side: null, contracts: 0n };

/**
 * Decide the next order to move `positionContracts` toward the target sign,
 * respecting every cap. Returns {side:null} when no order should be sent.
 */
export function decideOrder(i: SizingInput): SizingDecision {
  if (i.target === "flat") return { ...NONE, reason: "target flat" };
  if (i.turnoverContracts >= i.maxDailyTurnoverContracts) {
    return { ...NONE, reason: "daily turnover cap reached" };
  }

  const desiredSign = i.target === "long" ? 1n : -1n;
  const pos = i.positionContracts;
  const posSign = pos === 0n ? 0n : pos < 0n ? -1n : 1n;

  // If we're already positioned on the desired side at/above the cap, hold.
  const absPos = pos < 0n ? -pos : pos;
  if (posSign === desiredSign && absPos >= i.maxPositionContracts) {
    return { ...NONE, reason: "at position cap on desired side" };
  }

  const side: "buy" | "sell" = desiredSign === 1n ? "buy" : "sell";

  // Headroom to the cap on the far side of the flip: closing an opposite
  // position is always allowed up to |pos|; opening is bounded by the cap.
  // Target signed position is +/- maxPositionContracts; step toward it.
  const targetSigned = desiredSign * i.maxPositionContracts;
  const gap = targetSigned - pos; // same sign as desiredSign when work remains
  const gapAbs = gap < 0n ? -gap : gap;
  if (gapAbs === 0n) return { ...NONE, reason: "already at target" };

  // clamp to configured order size, market max, and remaining turnover
  const turnoverLeft = i.maxDailyTurnoverContracts - i.turnoverContracts;
  let contracts = min(i.orderContracts, gapAbs, i.maxOrderContracts, turnoverLeft);

  if (contracts < i.minOrderContracts) {
    // Can't place a compliant order this small; if the gap itself is smaller
    // than the market minimum, just hold rather than overshoot the cap.
    if (gapAbs < i.minOrderContracts) return { ...NONE, reason: "gap below market minimum; holding" };
    contracts = i.minOrderContracts;
    if (contracts > i.maxOrderContracts || contracts > turnoverLeft) {
      return { ...NONE, reason: "market minimum exceeds remaining headroom" };
    }
  }

  return { side, contracts, reason: `stepping ${i.target} by ${contracts}` };
}

function min(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b < a ? b : a));
}
