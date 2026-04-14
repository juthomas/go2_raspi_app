import type { Go2PointCloudMessage, Go2WsMessage } from "../types/go2";
import { isGo2PointCloudMessage } from "../types/go2";

type Handlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
  onHello?: (msg: Go2WsMessage) => void;
  onPointCloud?: (msg: Go2PointCloudMessage) => void;
};

export class Go2BridgeClient {
  private ws: WebSocket | null = null;
  private readonly handlers: Handlers;

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

    this.ws.onopen = () => this.handlers.onOpen?.();
    this.ws.onclose = () => this.handlers.onClose?.();
    this.ws.onerror = () =>
      this.handlers.onError?.("WebSocket error: bridge offline or URL unreachable.");
    this.ws.onmessage = (event) => this.handleMessage(event.data);
  }

  disconnect(): void {
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
    }
  }
}
