/**
 * REST client for the HardBasis public API. Only public knowledge:
 *   https://docs.hardbasis.com/api/authentication  (x-api-key header)
 *   https://docs.hardbasis.com/api/rate-limits      (headers + 429 doctrine)
 *   https://docs.hardbasis.com/api/errors           ({error, code} envelope)
 *
 * Returns a result object rather than throwing on non-2xx, so invariant checks
 * can inspect a refusal's `code` without exception plumbing. Money is NEVER
 * parsed to Number here — bodies come back as raw JSON and are parsed at the
 * edge via money.ts.
 */
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger.ts";
import type { ErrorBody } from "./types.ts";

export interface RateLimitSnapshot {
  limit: bigint | null;
  remaining: bigint | null;
  resetEpochS: bigint | null;
  retryAfterS: number | null;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  status: number;
  code: string | null; // machine ErrorCode on a refusal, else null
  body: T;
  headers: Headers;
  rateLimit: RateLimitSnapshot;
  /** raw response text, kept verbatim for finding evidence */
  raw: string;
  /** how the request was shaped, for evidence capture */
  request: { method: string; path: string; idempotencyKey?: string };
}

export interface RequestOpts {
  key?: string; // x-api-key value
  idempotencyKey?: string; // omit to auto-generate for mutating verbs
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  /** disable 429 auto-backoff (used when deliberately provoking a 429) */
  noRetry?: boolean;
  /** override the idempotency behaviour: never send the header */
  noIdempotency?: boolean;
  /** send a raw string body instead of JSON (for body_too_large probing) */
  rawBody?: string;
  headers?: Record<string, string>;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parseBig(h: string | null): bigint | null {
  return h !== null && /^-?\d+$/.test(h) ? BigInt(h) : null;
}

export class HttpClient {
  /** per-endpoint request counters for the daily summary */
  readonly counts = new Map<string, number>();
  readonly codeCounts = new Map<string, number>();

  constructor(
    private baseUrl: string,
    private log: Logger,
    private maxRetries = 3,
  ) {}

  private countEndpoint(method: string, template: string): void {
    const k = `${method} ${template}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    if (opts.key) headers["x-api-key"] = opts.key;

    const idem =
      opts.noIdempotency || !MUTATING.has(method)
        ? undefined
        : (opts.idempotencyKey ?? randomUUID());
    if (idem) headers["idempotency-key"] = idem;

    let payload: string | undefined;
    if (opts.rawBody !== undefined) {
      payload = opts.rawBody;
      headers["content-type"] = "application/json";
    } else if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }

    // path template for counting (collapse ids)
    const template = path.replace(/\/(hb_[^/]+|[0-9a-f-]{8,})(?=\/|$)/g, "/:id");
    this.countEndpoint(method, template);

    let attempt = 0;
    for (;;) {
      const res = await fetch(url, { method, headers, body: payload });
      const raw = await res.text();
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw; // non-JSON (e.g. HTML dashboards) — keep raw
        }
      }
      const rateLimit: RateLimitSnapshot = {
        limit: parseBig(res.headers.get("x-ratelimit-limit")),
        remaining: parseBig(res.headers.get("x-ratelimit-remaining")),
        resetEpochS: parseBig(res.headers.get("x-ratelimit-reset")),
        retryAfterS: res.headers.get("retry-after") ? Number(res.headers.get("retry-after")) : null,
      };
      const code = !res.ok && body && typeof body === "object" ? ((body as ErrorBody).code ?? null) : null;
      if (code) this.codeCounts.set(code, (this.codeCounts.get(code) ?? 0) + 1);

      // 429 backoff — bounded, honours Retry-After; skipped when noRetry.
      if (res.status === 429 && !opts.noRetry && attempt < this.maxRetries) {
        attempt++;
        const waitS = rateLimit.retryAfterS ?? 1;
        const waitMs = Math.min(Math.max(waitS, 1), 30) * 1000;
        this.log.warn("rate limited; backing off", { method, path: template, waitMs, attempt });
        await sleep(waitMs);
        continue;
      }

      return {
        ok: res.ok,
        status: res.status,
        code,
        body: body as T,
        headers: res.headers,
        rateLimit,
        raw,
        request: { method, path: url.pathname + url.search, ...(idem ? { idempotencyKey: idem } : {}) },
      };
    }
  }

  /** Happy-path helper: throw with verbatim evidence if the call was refused. */
  async ok<T = unknown>(method: string, path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
    const r = await this.request<T>(method, path, opts);
    if (!r.ok) {
      throw new ApiError(`${method} ${path} → ${r.status} ${r.code ?? ""}`.trim(), r);
    }
    return r;
  }

  get<T = unknown>(path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
    return this.request<T>("GET", path, opts);
  }
  post<T = unknown>(path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
    return this.request<T>("POST", path, opts);
  }
  del<T = unknown>(path: string, opts: RequestOpts = {}): Promise<ApiResult<T>> {
    return this.request<T>("DELETE", path, opts);
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly result: ApiResult,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
