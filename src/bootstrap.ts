/**
 * Self-bootstrapping credentials — the zero-human-step onboarding, demonstrated
 * rather than asserted. On first run with no stored state the bot runs the
 * Quickstart loop itself: signup → faucet → mint a trade-scoped delegate →
 * (optionally) mint a withdraw-scoped delegate → persist to state (0600).
 *
 * A stranger supplies nothing but the base URL; the VM holds no pre-provisioned
 * secret. Reuses stored state on every subsequent run.
 */
import type { Api } from "./api.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Store, BotState } from "./state.ts";
import { ApiError } from "./http.ts";

export async function ensureBootstrapped(
  api: Api,
  store: Store,
  cfg: Config,
  log: Logger,
  deployment: string,
  now: () => number = Date.now,
): Promise<BotState> {
  const existing = store.load();
  if (existing) {
    log.info("loaded existing bot state", {
      accountId: existing.accountId,
      hasTradeKey: Boolean(existing.tradeKey),
      hasWithdrawKey: Boolean(existing.withdrawKey),
    });
    return existing;
  }

  log.info("no stored state — self-bootstrapping a fresh account");

  if (cfg.maxSignups < 1) throw new Error("HB_MAX_SIGNUPS is 0 but no state exists; cannot bootstrap");

  // 1. Sign up → full-scope master key (shown once).
  const signup = await api.signup();
  if (!signup.ok) throw new ApiError("signup failed", signup);
  const accountId = signup.body.accountId;
  const masterKey = signup.body.apiKey;
  if (!accountId || !masterKey) {
    throw new ApiError("signup 201 lacked accountId/apiKey (undocumented response schema)", signup);
  }
  log.info("signed up", { accountId }); // never log the key itself

  // 2. Faucet.
  const faucet = await api.faucet(masterKey);
  if (!faucet.ok) throw new ApiError("faucet failed", faucet);
  log.info("faucet granted");

  // 3. Mint a ["read","trade"] delegate for the loop. Master then goes cold.
  const trade = await api.mintSession(masterKey, ["read", "trade"], "soak-bot-trade");
  if (!trade.ok || !trade.body.apiKey) throw new ApiError("mint trade delegate failed", trade);
  log.info("minted trade delegate", { keyId: trade.body.keyId, scopes: trade.body.scopes });

  // 4. Mint a ["withdraw"] delegate for the periodic withdrawal check.
  let withdrawKey: string | undefined;
  let withdrawKeyId: string | undefined;
  const wd = await api.mintSession(masterKey, ["withdraw"], "soak-bot-withdraw");
  if (wd.ok && wd.body.apiKey) {
    withdrawKey = wd.body.apiKey;
    withdrawKeyId = wd.body.keyId;
    log.info("minted withdraw delegate", { keyId: wd.body.keyId, scopes: wd.body.scopes });
  } else {
    log.warn("could not mint withdraw delegate; withdrawal check will use master", {
      status: wd.status,
      code: wd.code,
    });
  }

  const state: BotState = {
    version: 1,
    baseUrl: cfg.baseUrl,
    deployment,
    accountId,
    masterKey,
    tradeKey: trade.body.apiKey,
    tradeKeyId: trade.body.keyId,
    ...(withdrawKey ? { withdrawKey, withdrawKeyId } : {}),
    createdTsMs: now(),
    signups: 1,
    faucetDraws: 1,
    deadmanFired: false,
    confirmExercised: false,
  };
  store.save(state);
  log.info("bootstrap complete; state persisted (0600)", { stateExists: store.exists() });
  return state;
}
