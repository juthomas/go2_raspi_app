import type { Go2PointCloudMessage, Go2VoxelMapMessage, Go2WsMessage } from "../types/go2";
import { isGo2PointCloudMessage, isGo2VoxelMapMessage } from "../types/go2";

type Handlers = {
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
  onError?: (message: string) => void;
  onHello?: (msg: Go2WsMessage) => void;
  onPointCloud?: (msg: Go2PointCloudMessage) => void;
  onVoxelMap?: (msg: Go2VoxelMapMessage) => void;
  onLatency?: (latencyMs: number | null) => void;
};

function normalizeLidarWsUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  const appHost = window.location.hostname;
  const appIsRemote = appHost !== "localhost" && appHost !== "127.0.0.1";
  if ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && appIsRemote) {
    parsed.hostname = appHost;
  }
  return parsed.toString();
}

export class Go2BridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = false;
  private currentUrl = "";
  private readonly handlers: Handlers;
  private pingTimer: number | null = null;
  private pingSeq = 0;
  private readonly pendingPings = new Map<number, number>();

  constructor(handlers: Handlers) {
    this.handlers = handlers;
  }

  static defaultUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return `${protocol}//127.0.0.1:8765`;
    }
    return `${protocol}//${host}:8765`;
  }

  connect(url: string): void {
    this.currentUrl = url;
    this.shouldReconnect = true;
    this.clearReconnectTimer();
    this.openSocket();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.clearReconnectTimer();
    this.stopPingLoop();
    this.handlers.onLatency?.(null);
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // Ignore close errors from stale sockets.
    }
    this.ws = null;
    this.reconnectAttempt = 0;
  }

  private openSocket(): void {
    if (!this.currentUrl.trim()) {
      this.handlers.onError?.("LiDAR WS URL vide.");
      return;
    }

    this.disconnectSocketOnly();

    let ws: WebSocket;
    try {
      const parsed = new URL(normalizeLidarWsUrl(this.currentUrl));
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        this.handlers.onError?.("Bad WS URL (use ws:// or wss://)");
        return;
      }
      ws = new WebSocket(parsed.toString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.handlers.onError?.(`WS init error: ${msg}`);
      return;
    }

    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.handlers.onOpen?.();
      this.startPingLoop();
    };
    ws.onclose = (ev) => {
      this.stopPingLoop();
      this.handlers.onLatency?.(null);
      const reason = ev.reason || "connection closed";
      this.handlers.onClose?.(ev.code, reason);
      this.ws = null;
      if (this.shouldReconnect) this.scheduleReconnect();
    };
    ws.onerror = () => {
      this.handlers.onError?.("WebSocket error: bridge offline or URL unreachable.");
    };
    ws.onmessage = (event) => this.handleMessage(event.data);
  }

  private disconnectSocketOnly(): void {
    this.stopPingLoop();
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // Ignore close errors from stale sockets.
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempt += 1;
    const delayMs = Math.min(5000, 500 * 2 ** Math.min(this.reconnectAttempt - 1, 4));
    this.handlers.onError?.(`LiDAR WS reconnect in ${(delayMs / 1000).toFixed(1)}s...`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) this.openSocket();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.handlers.onError?.("Invalid JSON received from bridge.");
      return;
    }

    const msg = parsed as Partial<Go2WsMessage> & { type?: string; msg?: string };
    if (msg.type === "pong") {
      const seq = Number((msg as { seq?: number }).seq);
      if (Number.isFinite(seq)) {
        const sentAt = this.pendingPings.get(seq);
        if (typeof sentAt === "number") {
          this.pendingPings.delete(seq);
          this.handlers.onLatency?.(Math.max(0, Math.round(performance.now() - sentAt)));
        }
      }
      return;
    }
    if (msg.type === "hello") {
      this.handlers.onHello?.(msg as Go2WsMessage);
      return;
    }
    if (msg.type === "error") {
      this.handlers.onError?.(String(msg.msg ?? "Unknown bridge error"));
      return;
    }
    if (isGo2PointCloudMessage(msg)) {
      this.handlers.onPointCloud?.(msg);
      return;
    }
    if (isGo2VoxelMapMessage(msg)) {
      this.handlers.onVoxelMap?.(msg);
    }
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    this.pingTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const seq = ++this.pingSeq;
      this.pendingPings.set(seq, performance.now());
      if (this.pendingPings.size > 20) {
        const oldestKey = this.pendingPings.keys().next().value;
        if (typeof oldestKey === "number") this.pendingPings.delete(oldestKey);
      }
      try {
        this.ws.send(JSON.stringify({ type: "ping", seq, client_ts_ms: Date.now() }));
      } catch {
        // Ignore send error; close handler will update state.
      }
    }, 2000);
  }

  private stopPingLoop(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.pendingPings.clear();
  }
}
