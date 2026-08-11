/**
 * Typed facade over HttpClient for the HardBasis public endpoints the bot uses.
 * Thin on purpose — every method is a documented endpoint; nothing here knows
 * anything the public docs don't.
 */
import type { HttpClient, ApiResult, RequestOpts } from "./http.ts";
import type {
  Account,
  CancelAllAfterResult,
  Limits,
  MintSessionResult,
  OrderRef,
  PlaceOrderBody,
  PlaceOrderResult,
  Position,
  PublicMarket,
  Scope,
  SignupResult,
  Withdrawal,
  WithdrawalQuote,
} from "./types.ts";

export class Api {
  constructor(readonly http: HttpClient) {}

  // ── System / public ──────────────────────────────────────────────────────
  deployment = () => this.http.get<{ deployment?: string }>("/deployment");
  healthz = () => this.http.get<{ ok: boolean; db: boolean; tsMs: string }>("/healthz");
  markets = () => this.http.get<PublicMarket[]>("/v1/markets");
  market = (id: string) => this.http.get<PublicMarket>(`/v1/markets/${encodeURIComponent(id)}`);
  marketFunding = (id: string) => this.http.get<unknown[]>(`/v1/markets/${encodeURIComponent(id)}/funding`);
  stats24h = (id: string) => this.http.get<unknown>(`/v1/markets/${encodeURIComponent(id)}/stats24h`);
  candles = (id: string, limit?: string) =>
    this.http.get<unknown>(`/v1/markets/${encodeURIComponent(id)}/candles`, {
      query: { interval: "60", ...(limit ? { limit } : {}) },
    });
  ticker = () => this.http.get<unknown>("/v1/public/ticker");
  por = () => this.http.get<string>("/por");
  porDashboard = () => this.http.get<string>("/por/dashboard");

  // ── Onboarding ───────────────────────────────────────────────────────────
  signup = (idempotencyKey?: string) =>
    this.http.post<SignupResult>("/v1/signup", { body: {}, ...(idempotencyKey ? { idempotencyKey } : {}) });
  faucet = (key: string) => this.http.post<unknown>("/v1/faucet", { key });

  // ── Account & history ────────────────────────────────────────────────────
  account = (key: string) => this.http.get<Account>("/v1/account", { key });
  positions = (key: string) => this.http.get<Position[]>("/v1/positions", { key });
  limits = (key: string) => this.http.get<Limits>("/v1/limits", { key });
  porProof = (key: string) => this.http.get<unknown>("/v1/por/proof", { key });
  fills = (key: string, beforeSeq?: string, limit = "50") =>
    this.http.get<Page<"fills">>("/v1/fills", { key, query: { limit, ...(beforeSeq ? { beforeSeq } : {}) } });
  deposits = (key: string, beforeSeq?: string, limit = "50") =>
    this.http.get<Page<"deposits">>("/v1/deposits", { key, query: { limit, ...(beforeSeq ? { beforeSeq } : {}) } });
  funding = (key: string, beforeSeq?: string, limit = "50") =>
    this.http.get<Page<"funding">>("/v1/funding", { key, query: { limit, ...(beforeSeq ? { beforeSeq } : {}) } });
  withdrawals = (key: string, beforeSeq?: string, limit = "50") =>
    this.http.get<Page<"withdrawals">>("/v1/withdrawals", {
      key,
      query: { limit, ...(beforeSeq ? { beforeSeq } : {}) },
    });
  depositInvoice = (key: string, amountMsat?: string) =>
    this.http.post<unknown>("/v1/deposit-invoices", { key, body: amountMsat ? { amountMsat } : {} });

  // ── Sessions / keys ──────────────────────────────────────────────────────
  sessions = (key: string) => this.http.get<{ sessions: unknown[] }>("/v1/sessions", { key });
  mintSession = (key: string, scopes: Scope[], label = "bot") =>
    this.http.post<MintSessionResult>("/v1/sessions", { key, body: { label, scopes } });
  revokeSession = (key: string, body: { keyId?: string; allButCurrent?: boolean }) =>
    this.http.post<{ revoked: string[] }>("/v1/sessions/revoke", { key, body });

  // ── Orders ───────────────────────────────────────────────────────────────
  orders = (key: string, query: Record<string, string | string[] | undefined> = {}) =>
    this.http.get<Page<"orders">>("/v1/orders", { key, query });
  placeOrder = (key: string, body: PlaceOrderBody, opts: RequestOpts = {}) =>
    this.http.post<PlaceOrderResult>("/v1/orders", { key, body, ...opts });
  getOrder = (key: string, id: string) => this.http.get<OrderRef>(`/v1/orders/${encodeURIComponent(id)}`, { key });
  cancelOrder = (key: string, id: string) =>
    this.http.del<{ orderId: string; canceled: boolean }>(`/v1/orders/${encodeURIComponent(id)}`, { key });
  cancelAllAfter = (key: string, timeoutMs: string) =>
    this.http.post<CancelAllAfterResult>("/v1/cancel-all-after", { key, body: { timeoutMs } });

  // ── Withdrawals ──────────────────────────────────────────────────────────
  withdrawQuote = (key: string, body: { toAddress?: string; invoice?: string; amountMsat: string }) =>
    this.http.post<WithdrawalQuote>("/v1/withdrawals/quote", { key, body });
  withdraw = (
    key: string,
    body: { amountMsat: string; toAddress?: string; invoice?: string; confirmToken?: string },
    opts: RequestOpts = {},
  ) => this.http.post<{ railRef: string; queued: boolean }>("/v1/withdrawals", { key, body, ...opts });
}

/** A cursor-page envelope: `{ [itemsKey]: T[], nextBeforeSeq: string|null }`. */
export type Page<K extends string> = { [P in K]: unknown[] } & { nextBeforeSeq: string | null };

/**
 * Walk a cursor endpoint to EXHAUSTION (never sampled — that is where
 * nextBeforeSeq bugs live). Guards against a non-decreasing cursor (which would
 * loop forever) and caps total pages as a backstop.
 */
export async function walkCursor(
  itemsKey: string,
  fetchPage: (beforeSeq?: string) => Promise<ApiResult<Record<string, unknown>>>,
  maxPages = 1000,
): Promise<{ items: unknown[]; pages: number; cursors: (string | null)[]; envelopeOk: boolean; looped: boolean }> {
  const items: unknown[] = [];
  const cursors: (string | null)[] = [];
  let beforeSeq: string | undefined = undefined;
  let pages = 0;
  let envelopeOk = true;
  let looped = false;
  let prevCursor: bigint | null = null;
  for (;;) {
    const r = await fetchPage(beforeSeq);
    pages++;
    const body = (r.body ?? {}) as Record<string, unknown>;
    const batch = body[itemsKey];
    if (!Array.isArray(batch) || !("nextBeforeSeq" in body)) envelopeOk = false;
    if (Array.isArray(batch)) items.push(...batch);
    const next = (body.nextBeforeSeq ?? null) as string | null;
    cursors.push(next);
    if (next === null) break;
    // cursor must strictly decrease, or we would page forever
    const nextBig = /^-?\d+$/.test(next) ? BigInt(next) : null;
    if (nextBig !== null && prevCursor !== null && nextBig >= prevCursor) {
      looped = true;
      break;
    }
    prevCursor = nextBig;
    beforeSeq = next;
    if (pages >= maxPages) {
      looped = true;
      break;
    }
  }
  return { items, pages, cursors, envelopeOk, looped };
}
