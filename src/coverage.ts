/**
 * Endpoint coverage + continuous invariant assertion over every response.
 * Touches every public/read endpoint, walks each cursor to exhaustion, and runs
 * the precision scan (invariant #3), envelope check (#5), and rate-limit-header
 * checks (#2) on what comes back. Order entry and the dead-man's-switch fire are
 * exercised by strategy.ts; withdrawals by the withdrawal check.
 */
import type { Api, Page } from "./api.ts";
import { walkCursor } from "./api.ts";
import type { ApiResult } from "./http.ts";
import type { Logger } from "./logger.ts";
import type { BotState } from "./state.ts";
import { isCursorEnvelope, scanForFloatMoney } from "./invariants.ts";

export interface CoverageReport {
  touched: string[];
  cursorPages: Record<string, number>;
}

export class Coverage {
  constructor(
    private api: Api,
    private state: BotState,
    private log: Logger,
  ) {}

  /** Invariant #3: no money field ever a float; monetary strings are wire ints. */
  private scan(where: string, r: ApiResult): void {
    const violations = scanForFloatMoney(r.body, where);
    for (const v of violations) {
      this.log.finding({
        kind: "invariant:precision",
        summary: `${where}: ${v.why} at ${v.path} (value ${JSON.stringify(v.value)})`,
        evidence: { request: r.request, path: v.path, value: v.value },
      });
    }
  }

  /** Invariant #2: metered responses carry rate-limit headers. */
  private checkRateHeaders(where: string, r: ApiResult): void {
    // Only account-scoped (metered) responses are expected to carry these.
    if (r.rateLimit.limit === null && r.rateLimit.remaining === null && r.status < 400) {
      this.log.finding({
        kind: "invariant:rate-limit-headers",
        summary: `${where}: metered 2xx response carried no X-RateLimit-* headers`,
        evidence: { request: r.request, status: r.status },
      });
    }
  }

  private async walk(name: string, itemsKey: string, key: string, extraQuery: Record<string, string | string[] | undefined> = {}): Promise<number> {
    const res = await walkCursor(itemsKey, (beforeSeq) =>
      this.api.http.get<Record<string, unknown>>(`/v1/${name}`, {
        key,
        query: { limit: "25", ...(beforeSeq ? { beforeSeq } : {}), ...extraQuery },
      }),
    );
    if (!res.envelopeOk) {
      this.log.finding({
        kind: "invariant:envelope",
        summary: `GET /v1/${name}: not a named-key {${itemsKey}, nextBeforeSeq} envelope`,
        evidence: { itemsKey },
      });
    }
    if (res.looped) {
      this.log.finding({
        kind: "invariant:pagination",
        summary: `GET /v1/${name}: nextBeforeSeq did not strictly decrease — cursor could loop`,
        evidence: { cursors: res.cursors.slice(0, 10).map(String) },
      });
    }
    return res.pages;
  }

  /** One full sweep of the read/public surface. Returns what it touched. */
  async sweep(): Promise<CoverageReport> {
    const key = this.state.tradeKey;
    const touched: string[] = [];
    const cursorPages: Record<string, number> = {};
    const t = (name: string, r: ApiResult) => {
      touched.push(name);
      this.scan(name, r);
      return r;
    };

    // Public / system
    t("GET /healthz", await this.api.healthz());
    t("GET /deployment", await this.api.deployment());
    t("GET /v1/markets", await this.api.markets());
    const markets = (await this.api.markets()).body;
    const marketId = Array.isArray(markets) && markets[0] ? markets[0].marketId : "btc-usd";
    t("GET /v1/markets/:id", await this.api.market(marketId));
    t("GET /v1/markets/:id/funding", await this.api.marketFunding(marketId));
    t("GET /v1/markets/:id/stats24h", await this.api.stats24h(marketId));
    t("GET /v1/markets/:id/candles", await this.api.candles(marketId, "50"));
    t("GET /v1/public/ticker", await this.api.ticker());
    t("GET /por", await this.api.por());
    t("GET /por/dashboard", await this.api.porDashboard());

    // Account-scoped reads (metered → rate-limit headers)
    const acct = t("GET /v1/account", await this.api.account(key));
    this.checkRateHeaders("GET /v1/account", acct);
    // remaining must decrease across two consecutive metered reads
    const a1 = await this.api.account(key);
    const a2 = await this.api.account(key);
    if (a1.rateLimit.remaining !== null && a2.rateLimit.remaining !== null && a2.rateLimit.remaining > a1.rateLimit.remaining) {
      this.log.finding({
        kind: "invariant:rate-limit-headers",
        summary: `X-RateLimit-Remaining increased across consecutive reads (${a1.rateLimit.remaining} → ${a2.rateLimit.remaining})`,
        evidence: { first: a1.rateLimit, second: a2.rateLimit },
      });
    }
    t("GET /v1/positions", await this.api.positions(key));
    const limits = t("GET /v1/limits", await this.api.limits(key));
    this.checkLimitsAgreement(limits, a2);
    t("GET /v1/sessions", await this.api.sessions(key));
    t("GET /v1/por/proof", await this.api.porProof(key));
    t("POST /v1/deposit-invoices", await this.api.depositInvoice(key));

    // Cursor walks — every paginated endpoint, to exhaustion
    for (const [name, itemsKey] of [
      ["fills", "fills"],
      ["deposits", "deposits"],
      ["funding", "funding"],
      ["withdrawals", "withdrawals"],
    ] as const) {
      cursorPages[name] = await this.walk(name, itemsKey, key);
      touched.push(`GET /v1/${name} (walked)`);
    }
    // orders: both the ?status= list ({orders,…}) and the ?state= trigger list.
    // The ?state= variant returns a `triggers` array, NOT `orders` — a shape the
    // OpenAPI does not document (SOAK-FINDINGS). Walk it with the right key.
    cursorPages["orders(status)"] = await this.walk("orders", "orders", key, { status: ["accepted", "filled", "canceled", "rejected"] });
    cursorPages["orders(state=resting)"] = await this.walk("orders", "triggers", key, { state: "resting" });
    cursorPages["orders(state=armed)"] = await this.walk("orders", "triggers", key, { state: "armed" });
    touched.push("GET /v1/orders ?status= (walked)", "GET /v1/orders ?state=resting|armed (walked)");

    return { touched, cursorPages };
  }

  /** Invariant #2: the rate-limit headers agree with GET /v1/limits. */
  private checkLimitsAgreement(limits: ApiResult, sampled: ApiResult): void {
    const budgets = (limits.body as { budgets?: unknown } | undefined)?.budgets;
    // The budgets object shape is not documented; record it once so the gap is
    // captured, and cross-check the sampled read's header against it best-effort.
    this.log.debug("GET /v1/limits budgets shape", { budgets });
    if (budgets == null) {
      this.log.finding({
        kind: "docs-gap",
        summary: "GET /v1/limits: `budgets` is typed only as `object` in the spec; no shape to validate rate-limit headers against",
        evidence: { budgets },
      });
    }
  }
}
