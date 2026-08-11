/**
 * Live reachability smoke — hits the real testnet gateway. EXCLUDED from CI and
 * from `pnpm test` unless HB_LIVE=1 (see vitest.config.ts), so a clone with no
 * network still goes green. Run it with:  HB_LIVE=1 pnpm test
 *
 * It reads only public endpoints (no signup / no trading) and asserts the wire
 * carries no float money — the precision invariant, verified against reality.
 */
import { describe, it, expect } from "vitest";
import { Logger } from "../src/logger.ts";
import { HttpClient } from "../src/http.ts";
import { Api } from "../src/api.ts";
import { scanForFloatMoney } from "../src/invariants.ts";

const base = process.env.HB_BASE_URL ?? "https://testnet.hardbasis.com";

describe("live public surface", () => {
  const log = new Logger({ logDir: "./logs", maxBytes: 1_000_000, maxFiles: 2 });
  const api = new Api(new HttpClient(base, log));

  it("GET /deployment says testnet", async () => {
    const r = await api.deployment();
    expect(r.ok).toBe(true);
    expect(r.body.deployment).toBe("testnet");
  });

  it("GET /v1/markets carries no float money", async () => {
    const r = await api.markets();
    expect(r.ok).toBe(true);
    expect(scanForFloatMoney(r.body, "markets")).toEqual([]);
    expect(Array.isArray(r.body)).toBe(true);
  });

  it("GET /v1/public/ticker carries no float money", async () => {
    const r = await api.ticker();
    expect(r.ok).toBe(true);
    expect(scanForFloatMoney(r.body, "ticker")).toEqual([]);
  });
});
