/**
 * The withdrawal check. Proves the payout path end to end on the Spark rail
 * (the one proven to settle on testnet — a Lightning payout is not exercisable
 * on the sim rail, per the Quickstart). Uses a `withdraw`-scoped delegate for
 * POST /v1/withdrawals; the quote is a `trade`-scoped call.
 *
 * Self-send: it withdraws a tiny amount to the account's OWN rail address, so
 * funds cycle back through the deposit path rather than leaving. Along the way
 * it exercises the first-seen confirmation flow (#428 confirmation_required)
 * WITHOUT moving money — a large withdraw with no confirmToken must be refused.
 */
import type { Api } from "./api.ts";
import type { Logger } from "./logger.ts";
import type { BotState } from "./state.ts";
import { parseWireInt, parseWireIntOrNull } from "./money.ts";
import { scanForFloatMoney } from "./invariants.ts";

const SETTLE_AMOUNT_MSAT = 50_000n; // 50 sats — tiny, self-sent

export async function withdrawalCheck(api: Api, state: BotState, log: Logger): Promise<void> {
  const withdrawKey = state.withdrawKey ?? state.masterKey;
  const acct = await api.account(state.tradeKey);
  if (!acct.ok) {
    log.warn("withdrawal check: could not read account", { status: acct.status, code: acct.code });
    return;
  }
  scanForFloatMoney(acct.body, "account");
  const railAddress = acct.body.railAddress;
  const free = parseWireInt(acct.body.freeMsat, "freeMsat");
  if (!railAddress) {
    log.finding({ kind: "docs-gap", summary: "GET /v1/account returned no railAddress; cannot form a Spark withdrawal", evidence: { body: acct.body } });
    return;
  }

  // 1. Quote (trade-scoped) to our own rail address.
  const quote = await api.withdrawQuote(state.tradeKey, { toAddress: railAddress, amountMsat: SETTLE_AMOUNT_MSAT.toString() });
  if (!quote.ok) {
    log.warn("withdrawal quote refused", { status: quote.status, code: quote.code });
    return;
  }
  scanForFloatMoney(quote.body, "withdraw-quote");
  const q = quote.body;
  const feeMsat = parseWireIntOrNull(q.feeMsat ?? null, "feeMsat") ?? 0n;
  const threshold = parseWireIntOrNull(q.confirmThresholdMsat ?? null, "confirmThresholdMsat");
  log.info("withdrawal quote", { path: q.path, feeMsat: feeMsat.toString(), firstSeen: q.firstSeen, confirmRequired: q.confirmRequired, threshold: threshold?.toString() });

  // 2. Exercise the 428 confirmation path WITHOUT moving money: if this is a
  //    first-seen destination with a threshold, a >=threshold withdraw lacking a
  //    confirmToken must be refused 428 confirmation_required.
  if (q.firstSeen && threshold !== null && free > threshold + feeMsat) {
    const big = threshold; // exactly at threshold
    const refused = await api.withdraw(withdrawKey, { amountMsat: big.toString(), toAddress: railAddress }, { noRetry: true });
    const ok428 = refused.status === 428 && refused.code === "confirmation_required";
    if (!ok428) {
      log.finding({
        kind: "invariant:error-code",
        summary: `first-seen >=threshold withdraw without confirmToken: expected 428 confirmation_required, got ${refused.status}/${refused.code}`,
        evidence: { request: refused.request, status: refused.status, body: refused.body },
      });
    } else {
      log.info("428 confirmation_required correctly refused a first-seen withdraw with no token");
    }
  }

  // 3. Actual small settle. If confirmRequired for this amount, echo the token.
  if (free < SETTLE_AMOUNT_MSAT + feeMsat) {
    log.warn("withdrawal check: insufficient free balance for the settle probe; skipping settle", { free: free.toString() });
    return;
  }
  const body: { amountMsat: string; toAddress: string; confirmToken?: string } = {
    amountMsat: SETTLE_AMOUNT_MSAT.toString(),
    toAddress: railAddress,
  };
  if (q.confirmRequired && q.confirmToken) body.confirmToken = q.confirmToken;
  const wd = await api.withdraw(withdrawKey, body);
  if (!wd.ok) {
    log.warn("withdrawal refused", { status: wd.status, code: wd.code, body: wd.body });
    return;
  }
  scanForFloatMoney(wd.body, "withdraw");
  log.info("withdrawal submitted", { railRef: wd.body.railRef, queued: wd.body.queued });

  // 4. Confirm it settled (state:"paid") within a bounded poll.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const list = await api.withdrawals(state.tradeKey, undefined, "1");
    const items = (list.body as { withdrawals?: Array<{ state: string; path: string; railRef: string | null }> }).withdrawals ?? [];
    scanForFloatMoney(list.body, "withdrawals");
    const latest = items[0];
    if (latest && latest.state === "paid") {
      log.info("withdrawal settled", { state: latest.state, path: latest.path, railRef: latest.railRef });
      return;
    }
    if (latest && latest.state === "returned") {
      log.finding({ kind: "friction", summary: "withdrawal returned rather than paid on the sim rail", evidence: { latest } });
      return;
    }
  }
  log.finding({ kind: "friction", summary: "withdrawal did not reach state:paid within 60s on testnet", evidence: {} });
}
