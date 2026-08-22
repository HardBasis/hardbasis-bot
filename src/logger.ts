/**
 * Structured JSON logging with bounded, rotated files — a 72h run on a 1 GB
 * droplet must not fill the disk. Two sinks:
 *   activity.log  — every request/decision, high volume, size-capped + rotated
 *   findings.log  — invariant violations & docs gaps only, low volume, ALERT
 *
 * Both also mirror to stdout so `docker logs` / journald capture them. An
 * ALERT-class line additionally fires the optional webhook/ntfy push so a
 * violation escapes an unwatched VM (all optional — a public user is never
 * forced into it).
 *
 * No logging dependency: a tiny size-capped writer keeps the dep tree minimal.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

export type Level = "debug" | "info" | "warn" | "error" | "alert";

export interface Finding {
  /** e.g. "docs-gap", "invariant:precision", "invariant:sequencing", "friction" */
  kind: string;
  summary: string;
  /** captured verbatim: the request and/or response that proves it */
  evidence?: unknown;
}

class RotatingSink {
  private path: string;
  private bytes = 0;
  constructor(
    private dir: string,
    private name: string,
    private maxBytes: number,
    private maxFiles: number,
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, name);
    this.bytes = existsSync(this.path) ? statSync(this.path).size : 0;
  }
  write(line: string): void {
    const buf = line.endsWith("\n") ? line : line + "\n";
    const size = Buffer.byteLength(buf);
    if (this.bytes + size > this.maxBytes && this.bytes > 0) this.rotate();
    appendFileSync(this.path, buf);
    this.bytes += size;
  }
  private rotate(): void {
    // findings.log → findings.log.1 → ... drop the oldest beyond maxFiles.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? this.path : `${this.path}.${i - 1}`;
      const to = `${this.path}.${i}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          /* best-effort; never let logging crash the bot */
        }
      }
    }
    this.bytes = 0;
  }
}

export interface LoggerOpts {
  logDir: string;
  maxBytes: number;
  maxFiles: number;
  alertWebhookUrl?: string;
  alertNtfyUrl?: string;
  /** stamped onto every line, finding, and alert (e.g. {instance, role, slot}),
   *  so a fleet's interleaved logs and pushed alerts are attributable. */
  base?: Record<string, unknown>;
  /** injectable clock so tests are deterministic; defaults to Date.now */
  now?: () => number;
}

export class Logger {
  private activity: RotatingSink;
  private findingsSink: RotatingSink;
  readonly findings: Finding[] = [];
  private now: () => number;
  private base: Record<string, unknown>;
  constructor(private opts: LoggerOpts) {
    this.activity = new RotatingSink(opts.logDir, "activity.log", opts.maxBytes, opts.maxFiles);
    this.findingsSink = new RotatingSink(opts.logDir, "findings.log", opts.maxBytes, opts.maxFiles);
    this.now = opts.now ?? Date.now;
    this.base = opts.base ?? {};
  }

  private emit(level: Level, msg: string, fields?: Record<string, unknown>): string {
    const rec = { ts: new Date(this.now()).toISOString(), ...this.base, level, msg, ...(fields ?? {}) };
    // BigInt is not JSON-serialisable by default; render it as a decimal string
    // (the same shape it has on the wire) rather than crash the logger.
    const line = JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    this.activity.write(line);
    if (level === "error" || level === "alert") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
    return line;
  }

  debug(msg: string, f?: Record<string, unknown>): void {
    this.emit("debug", msg, f);
  }
  info(msg: string, f?: Record<string, unknown>): void {
    this.emit("info", msg, f);
  }
  warn(msg: string, f?: Record<string, unknown>): void {
    this.emit("warn", msg, f);
  }
  error(msg: string, f?: Record<string, unknown>): void {
    this.emit("error", msg, f);
  }

  /** Record a finding: append to findings.log, count it, and fire an ALERT. */
  finding(f: Finding): void {
    this.findings.push(f);
    const rec = { ts: new Date(this.now()).toISOString(), ...this.base, ...f };
    const line = JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    this.findingsSink.write(line);
    this.alert(`FINDING ${f.kind}: ${f.summary}`, { finding: f });
  }

  /** ALERT-class line: stderr + optional webhook/ntfy so it escapes the box. */
  alert(msg: string, fields?: Record<string, unknown>): void {
    this.emit("alert", msg, fields);
    void this.push(msg);
  }

  private async push(msg: string): Promise<void> {
    // Prefix the pushed alert with instance/role so a fleet's escaped alerts say
    // WHICH bot fired — an unwatched VM alert is useless if it's anonymous.
    const tag = [this.base.instance, this.base.role].filter(Boolean).join("/");
    const tagged = tag ? `[${tag}] ${msg}` : msg;
    const jobs: Array<Promise<unknown>> = [];
    if (this.opts.alertWebhookUrl) {
      jobs.push(
        fetch(this.opts.alertWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: tagged, source: "hardbasis-bot", instance: this.base.instance ?? null, role: this.base.role ?? null }),
        }).catch(() => undefined),
      );
    }
    if (this.opts.alertNtfyUrl) {
      jobs.push(
        fetch(this.opts.alertNtfyUrl, {
          method: "POST",
          headers: { title: `hardbasis-bot${tag ? " " + tag : ""}`, priority: "high" },
          body: tagged,
        }).catch(() => undefined),
      );
    }
    await Promise.allSettled(jobs);
  }
}
