/**
 * Wire types, hand-derived from the published spec ONLY:
 *   https://docs.hardbasis.com/openapi.json  (vendored at spec/openapi.json)
 *   https://docs.hardbasis.com/api/reference/
 *
 * Nothing here is imported from the monorepo — by construction (separate repo)
 * that is impossible, which is the point of PAPI-6. Every money/price/rate/
 * time/count field is a decimal STRING on the wire (see money.ts); we keep them
 * as `string` here and parse at the edge, never as `number`.
 *
 * Per the changelog covenant, responses may gain fields at any time; these
 * interfaces are intentionally open (we read what we need, ignore the rest).
 */

/** Closed enum, verbatim from the spec's ErrorCode + the Errors page. */
export const ERROR_CODES = [
  "validation",
  "unauthorized",
  "insufficient_scope",
  "compliance_refused",
  "session_limit",
  "referral_forbidden",
  "not_found",
  "idempotency_key_reused",
  "conflict",
  "confirmation_required",
  "rate_limited",
  "feature_unavailable",
  "deposits_halted",
  "unavailable",
  "insufficient_balance",
  "insufficient_margin",
  "position_limit",
  "oi_cap",
  "reduce_only",
  "market_halted",
  "oracle_stale",
  "body_too_large",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Scope = "read" | "trade" | "withdraw" | "admin-sessions";
export type Deployment = "prod" | "testnet";

export interface ErrorBody {
  error: string;
  code?: string; // may be an unknown (newer-server) code — never assume membership
  // 428 confirmation-required carries extras:
  reason?: string;
  firstSeen?: boolean;
  confirmThresholdMsat?: string;
}

export interface SignupResult {
  // NOTE: the OpenAPI 201 for /v1/signup documents NO response schema; these
  // field names come from the Quickstart curl example alone. See SOAK-FINDINGS.
  accountId: string;
  apiKey: string;
  [k: string]: unknown;
}

export interface OraclePrice {
  midQ8: string;
  tsMs: string;
  confQ9?: string;
}

export interface PublicMarket {
  marketId: string;
  underlying: string;
  contractType: "inverse" | "quanto";
  oracleFeedId: string;
  quantoMultiplierMsat: string | null;
  status: "live" | "reduce_only" | "halted";
  tickSizeQ8: string;
  priceDp: string;
  minOrderContracts: string;
  maxOrderContracts: string;
  takerFeeQ9: string;
  maxLeverage: string;
  imRateQ9: string;
  mmRateQ9: string;
  baseSpreadQ9: string;
  fundingRateHourlyQ9: string;
  nextFundingTsMs: string;
  oracleStalenessMs: string;
  openInterestContracts: string;
  skewQ9: string;
  lastPrice: OraclePrice | null;
}

export interface Account {
  accountId: string;
  userId: string;
  railAddress: string;
  autoSweepThresholdMsat: string | null;
  freeMsat: string;
  reservedMsat: string;
  depositFees: Array<{ path: "spark" | "l1" | "lightning"; description: string; recommendedMinimumSats?: string }>;
}

export interface Position {
  marketId: string;
  side: "long" | "short";
  contracts: string;
  entryPriceQ8: string;
  marginMsat: string;
  fundingClockTsMs: string;
}

export type OrderStatus = "accepted" | "filled" | "canceled" | "rejected" | "resting" | "working";
export type OrderType = "market" | "limit" | "stop_market" | "take_profit_market";

export interface OrderRef {
  orderId: string;
  marketId: string;
  side: "buy" | "sell";
  type: OrderType;
  contracts: string;
  status: OrderStatus;
  reason: string | null;
}

/** A resting/armed conditional order as GET /v1/orders?state=… returns it.
 * `ocoGroup` is the bracket id for a bracket's protective legs and null for a
 * standalone trigger — the only field that tells the two apart. */
export interface TriggerSummary {
  orderId: string;
  marketId: string;
  kind: "entry" | "stop" | "take_profit";
  side: "buy" | "sell";
  contracts: string;
  reduceOnly: boolean;
  status: string;
  reason: string | null;
  ocoGroup: string | null;
}

export interface PlaceOrderBody {
  marketId: string;
  side: "buy" | "sell";
  type: OrderType;
  contracts: string;
  limitPriceQ8?: string;
  triggerPriceQ8?: string;
  maxSlippageQ9?: string;
  reduceOnly: boolean;
  trigger?: { kind: "entry" | "stop" | "take_profit"; level: string };
  bracket?: {
    entryKind: "market" | "trigger";
    entryLevel?: string;
    stopLevel?: string;
    takeProfitLevel?: string;
  };
}

export interface PlaceOrderResult {
  orderId: string;
  status: OrderStatus;
}

export interface CursorPage<T> {
  nextBeforeSeq: string | null;
  [items: string]: T[] | string | null; // e.g. { fills: T[], nextBeforeSeq }
}

export interface Fill {
  orderId: string;
  accountId: string;
  marketId: string;
  side: "buy" | "sell";
  closedContracts: string;
  openedContracts: string;
  execPriceQ8: string;
  spreadQ9: string;
  tradeNotionalMsat: string;
  feeMsat: string;
  impactMsat: string;
  realizedPnlMsat: string;
  fundingSettledMsat: string;
  seq: string;
  tsMs: string;
  [k: string]: unknown;
}

export interface Session {
  keyId: string;
  accountId: string;
  label: string;
  scopes: Scope[];
  createdTsMs: string;
  lastSeenTsMs: string | null;
  revokedTsMs: string | null;
  current: string;
  [k: string]: unknown;
}

export interface MintSessionResult {
  apiKey?: string;
  keyId: string;
  scopes: Scope[];
}

export interface Limits {
  tier: string;
  budgets: unknown; // shape undocumented in the spec — discovered at runtime
}

export interface CancelAllAfterResult {
  armed: boolean;
  deadlineTsMs: string | null;
}

export interface WithdrawalQuote {
  path?: string;
  feeMsat?: string;
  firstSeen?: boolean;
  confirmRequired?: boolean;
  confirmThresholdMsat?: string;
  confirmToken?: string;
  [k: string]: unknown;
}

export interface Withdrawal {
  idempotencyKey: string;
  amountMsat: string;
  feeMsat: string | null;
  state: "requested" | "queued" | "paid" | "returned";
  path: "spark" | "lightning";
  railRef: string | null;
  requestedTsMs: string;
  paidTsMs: string | null;
  [k: string]: unknown;
}
