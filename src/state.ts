/**
 * Persistent bot state — the self-bootstrapped credentials and run bookkeeping.
 * Written with mode 0600 (owner read/write only): it holds live API keys.
 *
 * The file is gitignored; nothing here is ever committed. A stranger supplies
 * only a base URL — this file is created by the bot's first run, not by a human.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface BotState {
  version: 1;
  baseUrl: string;
  deployment: string;
  accountId: string;
  /** full-scope master key — kept for minting delegates; not used in the loop */
  masterKey: string;
  /** ["read","trade"] delegate the trading loop runs on */
  tradeKey: string;
  tradeKeyId: string;
  /** ["withdraw"] delegate used only by the withdrawal check */
  withdrawKey?: string;
  withdrawKeyId?: string;
  createdTsMs: number;
  signups: number;
  faucetDraws: number;
  /** whether the deliberate dead-man's-switch fire has been done this install */
  deadmanFired: boolean;
  /** whether the first-seen 428 confirmation flow has been exercised this install */
  confirmExercised?: boolean;
}

export class Store {
  private path: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort on platforms without POSIX modes */
    }
    this.path = join(dir, "bot.state.json");
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  load(): BotState | null {
    if (!existsSync(this.path)) return null;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as BotState;
    return parsed;
  }

  /** Atomic write (temp + rename) with 0600 perms so a key never lands 0644. */
  save(state: BotState): void {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      /* best-effort */
    }
  }
}
