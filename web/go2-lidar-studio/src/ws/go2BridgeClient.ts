import type { Go2PointCloudMessage, Go2VoxelMapMessage, Go2WsMessage } from "../types/go2";
import { isGo2PointCloudMessage, isGo2VoxelMapMessage } from "../types/go2";

type Handlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
  onHello?: (msg: Go2WsMessage) => void;
  onPointCloud?: (msg: Go2PointCloudMessage) => void;
  onVoxelMap?: (msg: Go2VoxelMapMessage) => void;
  onLatency?: (latencyMs: number | null) => void;
};

export class Go2BridgeClient {
  private ws: WebSocket | null = null;
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
    this.disconnect();
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.handlers.onOpen?.();
      this.startPingLoop();
    };
    this.ws.onclose = () => {
      this.stopPingLoop();
      this.handlers.onLatency?.(null);
      this.handlers.onClose?.();
    };
    this.ws.onerror = () =>
      this.handlers.onError?.("WebSocket error: bridge offline or URL unreachable.");
    this.ws.onmessage = (event) => this.handleMessage(event.data);
  }

  disconnect(): void {
    this.stopPingLoop();
    this.handlers.onLatency?.(null);
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // Ignore close errors from stale sockets.
    }
    this.ws = null;
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.handlers.onError?.("Invalid JSON received from bridge.");
      return;
    }

    const msg = parsed as Partial<Go2WsMessage>;
    if ((msg as { type?: string }).type === "pong") {
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
      this.handlers.onError?.(String((msg as { msg?: string }).msg ?? "Unknown bridge error"));
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
      // Keep map bounded if pongs are lost.
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
