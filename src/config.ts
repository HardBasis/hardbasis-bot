/** Configuration, entirely from env (see .env.example). No secrets baked in. */
import { join } from "node:path";
import { resolveInstanceId, sanitizeId } from "./instance.ts";
import type { Stance } from "./decorrelate.ts";

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

export type Role = "auditor" | "trader";

export interface Config {
  baseUrl: string;
  wsUrl: string;
  allowNonTestnet: boolean;
  /** auditor = full endpoint coverage + probes + all invariants (the reference,
   *  single instance); trader = trade + WebSocket only, minimal REST polling. */
  role: Role;
  /** stable per-container label; keys the state/log dirs and tags every line */
  instanceId: string;
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
  // logging + state (per-instance subdirs derived from instanceId)
  logDir: string;
  stateDir: string;
  /** root of the shared state volume; slot state dirs hang off it */
  baseStateDir: string;
  /** shared across a service's replicas; holds the atomic slot locks */
  slotsDir: string;
  logMaxBytes: number;
  logMaxFiles: number;
  // multi-instance decorrelation (traders only; see decorrelate.ts)
  maxSlots: number;
  signupStaggerMs: number;
  signalPeriodMs: bigint;
  oscBandQ9: bigint;
  jitterPct: number;
  /** env pins for an explicitly-configured fleet of distinct services; unset =
   *  derive from the slot. Period/size take env as their BASE and still jitter. */
  stanceOverride?: Stance;
  phaseOffsetMs?: bigint;
  // alerts
  alertWebhookUrl: string;
  alertNtfyUrl: string;
  /** Fire one ALERT at startup to prove the webhook/ntfy escape path works. */
  alertSelfTest: boolean;
  // CLI
  once: boolean;
}

function role(): Role {
  const v = (process.env.HB_ROLE ?? "auditor").toLowerCase();
  if (v !== "auditor" && v !== "trader") {
    throw new Error(`env HB_ROLE must be "auditor" or "trader", got ${JSON.stringify(v)}`);
  }
  return v;
}

function stance(): Stance | undefined {
  const raw = process.env.HB_STANCE;
  if (raw === undefined || raw === "") return undefined;
  const v = raw.toLowerCase();
  if (v !== "momentum" && v !== "meanrevert") {
    throw new Error(`env HB_STANCE must be "momentum" or "meanrevert", got ${JSON.stringify(raw)}`);
  }
  return v;
}

function intOrUndef(name: string): bigint | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  if (!/^-?\d+$/.test(v)) throw new Error(`env ${name} must be an integer, got ${JSON.stringify(v)}`);
  return BigInt(v);
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const baseUrl = str("HB_BASE_URL", "https://testnet.hardbasis.com").replace(/\/+$/, "");
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/v1/ws";
  const baseStateDir = str("HB_STATE_DIR", "./state");
  const baseLogDir = str("HB_LOG_DIR", "./logs");
  const instanceId = resolveInstanceId();
  const seg = sanitizeId(instanceId);
  return {
    baseUrl,
    wsUrl,
    allowNonTestnet: bool("HB_ALLOW_NON_TESTNET") || argv.includes("--allow-non-testnet"),
    role: role(),
    instanceId,
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
    // Per-instance subdirs so N replicas on one shared volume never collide on
    // the 0600 state file or a log; _slots is shared so the ordinal claim works.
    //
    // logDir stays keyed on the instance id — logs SHOULD follow the container.
    // stateDir does not: it is resolved from the claimed SLOT once that is
    // known (see slotStateDir), because state carries the account and an
    // account must survive a recreate. Keying it on the container id is what
    // minted six accounts and six faucet grants on 2026-08-19.
    logDir: join(baseLogDir, seg),
    stateDir: join(baseStateDir, seg),
    baseStateDir,
    slotsDir: join(baseStateDir, "_slots"),
    logMaxBytes: num("HB_LOG_MAX_BYTES", 5_000_000),
    logMaxFiles: num("HB_LOG_MAX_FILES", 5),
    maxSlots: Number(int("HB_MAX_SLOTS", 16n)),
    signupStaggerMs: num("HB_SIGNUP_STAGGER_MS", 30_000),
    signalPeriodMs: int("HB_SIGNAL_PERIOD_MS", 600_000n),
    oscBandQ9: int("HB_OSC_BAND_Q9", 50_000_000n),
    jitterPct: num("HB_JITTER_PCT", 30),
    ...(stance() ? { stanceOverride: stance() } : {}),
    ...(intOrUndef("HB_PHASE_OFFSET_MS") !== undefined ? { phaseOffsetMs: intOrUndef("HB_PHASE_OFFSET_MS") } : {}),
    alertWebhookUrl: str("HB_ALERT_WEBHOOK_URL", ""),
    alertNtfyUrl: str("HB_ALERT_NTFY_URL", ""),
    alertSelfTest: bool("HB_ALERT_SELFTEST") || argv.includes("--alert-selftest"),
    once: argv.includes("--once"),
  };
}
