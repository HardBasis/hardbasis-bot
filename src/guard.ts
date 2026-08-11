/**
 * Off-testnet refusal. Built from https://docs.hardbasis.com/api/ :
 *   "Do not hardcode the environment from the hostname. GET /deployment returns
 *    {"deployment":"testnet"} or {"deployment":"prod"}."
 *
 * This is our own env probe, used for exactly what it was built for: a thing
 * strangers will run must refuse to trade anywhere real by default.
 */
import type { HttpClient } from "./http.ts";
import type { Deployment } from "./types.ts";

export class RefusedToTrade extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedToTrade";
  }
}

export async function assertTestnet(http: HttpClient, allowNonTestnet: boolean): Promise<Deployment> {
  const r = await http.get<{ deployment?: string }>("/deployment");
  if (!r.ok) {
    throw new RefusedToTrade(
      `GET /deployment failed (${r.status}); refusing to trade against an unverifiable deployment`,
    );
  }
  const deployment = r.body?.deployment;
  if (deployment !== "testnet" && !allowNonTestnet) {
    throw new RefusedToTrade(
      `deployment is ${JSON.stringify(deployment)}, not "testnet". Refusing to trade. ` +
        `This bot is a testnet reference client. Pass --allow-non-testnet (or set ` +
        `HB_ALLOW_NON_TESTNET=1) only if you truly mean to run against something of value — at your own risk.`,
    );
  }
  return (deployment ?? "prod") as Deployment;
}
