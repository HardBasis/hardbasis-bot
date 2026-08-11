/**
 * WebSocket client. Built from https://docs.hardbasis.com/api/websocket :
 *   one socket at wss://…/v1/ws, protocol v1 echoed in the auth ack;
 *   channels prices (feedId) / stats (marketId) / account (auth'd);
 *   client ops auth/subscribe/unsubscribe; server heartbeat {"op":"ping"};
 *   reconnect doctrine: REST snapshot first, then resume + dedup on seq;
 *   ignore unrecognised frames (additive evolution).
 *
 * NOTE: the exact field layout of the price/stats/account DATA frames is not
 * documented (only the client ops, the ping, and the ack are). We parse
 * defensively and surface the first frame of each shape as a finding so the gap
 * is recorded rather than guessed at silently. See SOAK-FINDINGS.
 */
import { WebSocket } from "ws";
import type { Logger } from "./logger.ts";

export interface WsCallbacks {
  onFrame?: (frame: Record<string, unknown>) => void;
  onPrice?: (feedId: string, midQ8: bigint | null, tsMs: bigint | null, frame: Record<string, unknown>) => void;
  onStats?: (marketId: string, frame: Record<string, unknown>) => void;
  onAccount?: (seq: bigint | null, frame: Record<string, unknown>) => void;
  onAck?: (frame: Record<string, unknown>) => void;
  onError?: (frame: Record<string, unknown>) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onProtocol?: (version: unknown) => void;
}

interface Sub {
  op: "subscribe";
  channel: "prices" | "stats" | "account";
  feedId?: string;
  marketId?: string;
}

function asBig(v: unknown): bigint | null {
  return typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v) : null;
}

/** Best-effort extraction of a mid price (q8) from an undocumented frame. */
function extractMid(frame: Record<string, unknown>): bigint | null {
  const candidates = [frame.midQ8, (frame.last as any)?.midQ8, (frame.price as any)?.midQ8, (frame.mark as any)?.midQ8];
  for (const c of candidates) {
    const b = asBig(c);
    if (b !== null) return b;
  }
  return null;
}
function extractTs(frame: Record<string, unknown>): bigint | null {
  const candidates = [frame.tsMs, (frame.last as any)?.tsMs, (frame.oracleTsMs as any), (frame.price as any)?.tsMs];
  for (const c of candidates) {
    const b = asBig(c);
    if (b !== null) return b;
  }
  return null;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private subs: Sub[] = [];
  private apiKey: string | null = null;
  private cancelOnDisconnect = false;
  private authed = false;
  private closedByUs = false;
  private backoffMs = 500;
  private seenShapes = new Set<string>();

  /** liveness: timestamp (ms) of the last frame received, for staleness. */
  lastFrameTsMs = 0;
  /** newest account `seq` observed on this connection (for reconnect dedup). */
  newestAccountSeq: bigint | null = null;
  /** newest oracle mid (q8) and its oracle timestamp, for the signal. */
  lastMidQ8: bigint | null = null;
  lastMidTsMs: bigint | null = null;
  protocolVersion: unknown = null;

  constructor(
    private url: string,
    private log: Logger,
    private cb: WsCallbacks = {},
    private now: () => number = Date.now,
  ) {}

  connect(): void {
    this.closedByUs = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.backoffMs = 500;
      this.log.info("ws open", { url: this.url });
      if (this.apiKey) this.sendAuth();
      for (const s of this.subs) this.sendRaw(s);
      this.cb.onOpen?.();
    });
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", (code, reasonBuf) => {
      this.authed = false;
      const reason = reasonBuf?.toString() ?? "";
      this.cb.onClose?.(code, reason);
      if (!this.closedByUs) {
        this.log.warn("ws closed; reconnecting", { code, reason, backoffMs: this.backoffMs });
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
      }
    });
    ws.on("error", (err) => this.log.warn("ws error", { err: String(err) }));
  }

  /** Register the auth intent; applied on connect and on every reconnect. */
  auth(apiKey: string, cancelOnDisconnect = false): void {
    this.apiKey = apiKey;
    this.cancelOnDisconnect = cancelOnDisconnect;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendAuth();
  }

  private sendAuth(): void {
    // cancelOnDisconnect is NOT in the documented WS auth frame; we send it to
    // probe whether the server honours it (coverage asks for both). The ack
    // shape tells us; recorded as a finding.
    const frame: Record<string, unknown> = { op: "auth", apiKey: this.apiKey };
    if (this.cancelOnDisconnect) frame.cancelOnDisconnect = true;
    this.sendRaw(frame);
  }

  subscribe(channel: "prices" | "stats" | "account", id?: { feedId?: string; marketId?: string }): void {
    const s: Sub = { op: "subscribe", channel, ...(id ?? {}) };
    this.subs.push(s);
    if (this.ws?.readyState === WebSocket.OPEN) this.sendRaw(s);
  }

  unsubscribe(channel: "prices" | "stats" | "account", id?: { feedId?: string; marketId?: string }): void {
    this.subs = this.subs.filter(
      (s) => !(s.channel === channel && s.feedId === id?.feedId && s.marketId === id?.marketId),
    );
    this.sendRaw({ op: "unsubscribe", channel, ...(id ?? {}) });
  }

  private sendRaw(frame: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  /** Deliberately drop the socket to exercise reconnect + resync (coverage). */
  kill(): void {
    this.log.info("ws deliberate kill (reconnect drill)");
    this.ws?.terminate();
  }

  /** Graceful shutdown: stop reconnecting and close. */
  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }

  isAuthed(): boolean {
    return this.authed;
  }

  /** ms since the last frame — the client's own staleness measure. */
  stalenessMs(): number {
    return this.lastFrameTsMs === 0 ? Number.POSITIVE_INFINITY : this.now() - this.lastFrameTsMs;
  }

  private onMessage(raw: string): void {
    this.lastFrameTsMs = this.now();
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.log.warn("ws non-JSON frame", { raw: raw.slice(0, 200) });
      return;
    }
    this.cb.onFrame?.(frame);
    const op = frame.op;

    if (op === "ping") {
      // The docs say "you may pong or ignore it", but there is no `pong` client
      // op — sending {op:"pong"} returns {error:"unknown op",code:"validation"}
      // (SOAK-FINDINGS). Receiving the ping is enough for liveness; we ignore it.
      this.recordShape("ping", frame);
      return;
    }
    if (op === "auth" || op === "authed" || op === "auth_ok" || "v" in frame) {
      if ("v" in frame) {
        this.protocolVersion = frame.v;
        this.cb.onProtocol?.(frame.v);
      }
      this.authed = true;
      this.cb.onAck?.(frame);
      this.recordShape("auth-ack", frame);
      return;
    }
    if (op === "ack" || op === "subscribed" || op === "unsubscribed") {
      this.cb.onAck?.(frame);
      this.recordShape(`ack:${String(frame.channel ?? "")}`, frame);
      return;
    }
    if (op === "error") {
      this.cb.onError?.(frame);
      return;
    }

    // Data frames — channel may be explicit or implied by feedId/marketId.
    const channel = frame.channel;
    if (channel === "prices" || (frame.feedId && !frame.marketId)) {
      const feedId = String(frame.feedId ?? "");
      const mid = extractMid(frame);
      const ts = extractTs(frame);
      if (mid !== null) {
        this.lastMidQ8 = mid;
        this.lastMidTsMs = ts;
      }
      this.recordShape("prices", frame);
      this.cb.onPrice?.(feedId, mid, ts, frame);
      return;
    }
    if (channel === "stats") {
      this.recordShape("stats", frame);
      this.cb.onStats?.(String(frame.marketId ?? ""), frame);
      return;
    }
    if (channel === "account") {
      const seq = asBig(frame.seq);
      if (seq !== null) this.newestAccountSeq = seq;
      this.recordShape("account", frame);
      this.cb.onAccount?.(seq, frame);
      return;
    }
    // Unrecognised frame — additive evolution; ignore, don't crash. Record once.
    this.recordShape("unknown", frame);
  }

  /** Surface the first instance of each frame shape so undocumented layouts are captured. */
  private recordShape(tag: string, frame: Record<string, unknown>): void {
    if (this.seenShapes.has(tag)) return;
    this.seenShapes.add(tag);
    this.log.debug("ws first frame of shape", { tag, keys: Object.keys(frame), sample: frame });
  }
}
