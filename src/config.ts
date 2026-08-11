/** Configuration, entirely from env (see .env.example). No secrets baked in. */

function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

function int(name: string, def: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  if (!/^-?\d+$/.test(v)) throw new Error(`env ${name} must be an integer, got ${JSON.stringify(v)}`);
  return BigInt(v);
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`env ${name} must be a non-negative number`);
  return n;
}

function bool(name: string): boolean {
  const v = (process.env[name] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export interface Config {
  baseUrl: string;
  wsUrl: string;
  allowNonTestnet: boolean;
  // caps (contracts are integer counts; kept as bigint)
  maxPositionContracts: bigint;
  maxDailyTurnoverContracts: bigint;
  orderContracts: bigint;
  maxSignups: number;
  maxFaucetDraws: number;
  // timing
  tickMs: number;
  deadmanMs: bigint;
  // confirmation-flow exercise (accumulate past the confirm threshold)
  exerciseConfirm: boolean;
  faucetPaceMs: number;
  faucetMaxWaitMs: number;
  // logging
  logDir: string;
  stateDir: string;
  logMaxBytes: number;
  logMaxFiles: number;
  // alerts
  alertWebhookUrl: string;
  alertNtfyUrl: string;
  /** Fire one ALERT at startup to prove the webhook/ntfy escape path works. */
  alertSelfTest: boolean;
  // CLI
  once: boolean;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const baseUrl = str("HB_BASE_URL", "https://testnet.hardbasis.com").replace(/\/+$/, "");
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/v1/ws";
  return {
    baseUrl,
    wsUrl,
    allowNonTestnet: bool("HB_ALLOW_NON_TESTNET") || argv.includes("--allow-non-testnet"),
    maxPositionContracts: int("HB_MAX_POSITION_CONTRACTS", 2000n),
    maxDailyTurnoverContracts: int("HB_MAX_DAILY_TURNOVER_CONTRACTS", 200_000n),
    orderContracts: int("HB_ORDER_CONTRACTS", 500n),
    maxSignups: Number(int("HB_MAX_SIGNUPS", 1n)),
    // enough draws to accumulate past the ~0.1 BTC confirm threshold (~12–15
    // draws), so the soak can exercise the first-seen 428 confirmation flow.
    maxFaucetDraws: Number(int("HB_MAX_FAUCET_DRAWS", 15n)),
    tickMs: num("HB_TICK_MS", 15_000),
    deadmanMs: int("HB_DEADMAN_MS", 60_000n),
    exerciseConfirm: !argv.includes("--no-confirm-exercise") && (process.env.HB_EXERCISE_CONFIRM ?? "1") !== "0",
    faucetPaceMs: num("HB_FAUCET_PACE_MS", 60_000),
    faucetMaxWaitMs: num("HB_FAUCET_MAX_WAIT_MS", 1_800_000),
    logDir: str("HB_LOG_DIR", "./logs"),
    stateDir: str("HB_STATE_DIR", "./state"),
    logMaxBytes: num("HB_LOG_MAX_BYTES", 5_000_000),
    logMaxFiles: num("HB_LOG_MAX_FILES", 5),
    alertWebhookUrl: str("HB_ALERT_WEBHOOK_URL", ""),
    alertNtfyUrl: str("HB_ALERT_NTFY_URL", ""),
    alertSelfTest: bool("HB_ALERT_SELFTEST") || argv.includes("--alert-selftest"),
    once: argv.includes("--once"),
  };
}
