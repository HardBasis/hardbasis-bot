import { describe, it, expect } from "vitest";
import { assertTestnet, RefusedToTrade } from "../src/guard.ts";
import type { HttpClient } from "../src/http.ts";

function fakeHttp(status: number, deployment?: string): HttpClient {
  return {
    get: async () => ({
      ok: status >= 200 && status < 300,
      status,
      code: null,
      body: deployment === undefined ? {} : { deployment },
      headers: new Headers(),
      rateLimit: { limit: null, remaining: null, resetEpochS: null, retryAfterS: null },
      raw: "",
      request: { method: "GET", path: "/deployment" },
    }),
  } as unknown as HttpClient;
}

describe("assertTestnet (off-testnet refusal)", () => {
  it("returns testnet when the deployment is testnet", async () => {
    expect(await assertTestnet(fakeHttp(200, "testnet"), false)).toBe("testnet");
  });

  it("refuses to trade on prod by default", async () => {
    await expect(assertTestnet(fakeHttp(200, "prod"), false)).rejects.toBeInstanceOf(RefusedToTrade);
  });

  it("allows a non-testnet deployment only with the explicit override", async () => {
    expect(await assertTestnet(fakeHttp(200, "prod"), true)).toBe("prod");
  });

  it("refuses when /deployment cannot be verified", async () => {
    await expect(assertTestnet(fakeHttp(503), false)).rejects.toBeInstanceOf(RefusedToTrade);
  });
});
