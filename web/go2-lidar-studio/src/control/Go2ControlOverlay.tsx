import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  enabled: boolean;
  active: boolean;
  wsUrl: string;
  speedVx: number;
  speedVyaw: number;
};

type Pressed = { up: boolean; down: boolean; left: boolean; right: boolean };

function usePressedState(): [Pressed, (k: keyof Pressed, v: boolean) => void] {
  const [pressed, setPressed] = useState<Pressed>({ up: false, down: false, left: false, right: false });
  const setKey = (key: keyof Pressed, value: boolean) =>
    setPressed((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  return [pressed, setKey];
}

function normalizeControlWsUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.hostname === "localhost") {
    // Avoid IPv6 localhost resolution mismatches when server only binds IPv4.
    parsed.hostname = "127.0.0.1";
  }
  return parsed.toString();
}

export function Go2ControlOverlay({ enabled, active, wsUrl, speedVx, speedVyaw }: Props) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState("OFF");
  const [isPilot, setIsPilot] = useState(false);
  const [lastAck, setLastAck] = useState("--");
  const [lastError, setLastError] = useState("--");
  const [pressed, setPressed] = usePressedState();
  const [serverStatus, setServerStatus] = useState<{ lastOp: string; lastCode: number; pilot: boolean } | null>(
    null,
  );

  const target = useMemo(() => {
    const vx = (pressed.up ? 1 : 0) * speedVx + (pressed.down ? -1 : 0) * speedVx;
    const vyaw = (pressed.left ? 1 : 0) * speedVyaw + (pressed.right ? -1 : 0) * speedVyaw;
    return { vx, vy: 0, vyaw };
  }, [pressed, speedVx, speedVyaw]);

  useEffect(() => {
    if (!enabled || !active) {
      setStatus(!enabled ? "OFF" : "Idle (connect LiDAR WS)");
      setIsPilot(false);
      setLastAck("--");
      setLastError("--");
      setServerStatus(null);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
      return;
    }

    let ws: WebSocket;
    try {
      const parsed = new URL(normalizeControlWsUrl(wsUrl));
      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        setStatus("Bad WS URL (use ws:// or wss://)");
        return;
      }
      ws = new WebSocket(parsed.toString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`WS init error: ${msg}`);
      setLastError(msg);
      return;
    }
    wsRef.current = ws;
    setStatus("Connecting...");
    const connectStartedAt = performance.now();
    let connectWatchdog: number | null = window.setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        setStatus("Connect timeout");
        setLastError("WebSocket connect timeout (check host/port/bridge)");
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }, 2500);

    ws.onopen = () => {
      if (connectWatchdog !== null) {
        window.clearTimeout(connectWatchdog);
        connectWatchdog = null;
      }
      setStatus("Connected");
      setLastError("--");
      ws.send(JSON.stringify({ type: "claim_pilot" }));
    };
    ws.onclose = (ev) => {
      if (connectWatchdog !== null) {
        window.clearTimeout(connectWatchdog);
        connectWatchdog = null;
      }
      const elapsed = Math.round(performance.now() - connectStartedAt);
      setStatus(`Closed (${ev.code})`);
      if (ev.reason) setLastError(`close ${ev.code}: ${ev.reason}`);
      else if (elapsed < 3000) setLastError(`close ${ev.code}: cannot reach bridge`);
      setIsPilot(false);
      wsRef.current = null;
    };
    ws.onerror = () => setStatus("Error");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as {
          type?: string;
          cmd?: string;
          ok?: boolean;
          msg?: string;
          last_code?: number;
          last_op?: string;
          last_error?: string;
          pilot?: boolean;
        };
        if (msg.type === "ack") {
          const text = `${msg.cmd ?? "?"}: ${msg.ok ? "ok" : "fail"}${msg.msg ? ` (${msg.msg})` : ""}`;
          setLastAck(text);
          if (msg.cmd === "claim_pilot" && msg.ok) setIsPilot(true);
          if (!msg.ok) setLastError(msg.msg ?? "command failed");
        } else if (msg.type === "error") {
          setLastError(msg.msg ?? "unknown error");
        } else if (msg.type === "status") {
          setServerStatus({
            lastOp: msg.last_op ?? "?",
            lastCode: Number(msg.last_code ?? 0),
            pilot: Boolean(msg.pilot),
          });
          if (msg.last_error) setLastError(msg.last_error);
        }
      } catch {
        // ignore parse errors
      }
    };

    return () => {
      if (connectWatchdog !== null) {
        window.clearTimeout(connectWatchdog);
        connectWatchdog = null;
      }
      try {
        wsRef.current?.send(JSON.stringify({ type: "release_pilot" }));
        wsRef.current?.close();
      } catch {
        // ignore close errors
      }
      wsRef.current = null;
      setIsPilot(false);
    };
  }, [enabled, active, wsUrl]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPressed("up", true);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setPressed("down", true);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPressed("left", true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPressed("right", true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp") setPressed("up", false);
      else if (e.key === "ArrowDown") setPressed("down", false);
      else if (e.key === "ArrowLeft") setPressed("left", false);
      else if (e.key === "ArrowRight") setPressed("right", false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [enabled, setPressed]);

  useEffect(() => {
    if (!enabled) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !isPilot) return;
    const timer = window.setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "twist",
          vx: target.vx,
          vy: target.vy,
          vyaw: target.vyaw,
        }),
      );
    }, 80);
    return () => window.clearInterval(timer);
  }, [enabled, target, isPilot]);

  const send = (payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  return (
    <div className={`control-overlay ${enabled ? "" : "hidden"}`}>
      <div className="control-header">Control WS: {status}</div>
      <div className="control-grid">
        <button
          onPointerDown={() => setPressed("up", true)}
          onPointerUp={() => setPressed("up", false)}
          onPointerCancel={() => setPressed("up", false)}
          onPointerLeave={() => setPressed("up", false)}
        >
          FWD
        </button>
        <button
          onPointerDown={() => setPressed("left", true)}
          onPointerUp={() => setPressed("left", false)}
          onPointerCancel={() => setPressed("left", false)}
          onPointerLeave={() => setPressed("left", false)}
        >
          LEFT
        </button>
        <button onClick={() => send({ type: "stop" })}>STOP</button>
        <button
          onPointerDown={() => setPressed("right", true)}
          onPointerUp={() => setPressed("right", false)}
          onPointerCancel={() => setPressed("right", false)}
          onPointerLeave={() => setPressed("right", false)}
        >
          RIGHT
        </button>
        <button
          onPointerDown={() => setPressed("down", true)}
          onPointerUp={() => setPressed("down", false)}
          onPointerCancel={() => setPressed("down", false)}
          onPointerLeave={() => setPressed("down", false)}
        >
          BACK
        </button>
      </div>
      <div className="control-actions">
        <button onClick={() => send({ type: "stand_up" })}>StandUp</button>
        <button onClick={() => send({ type: "stand_down" })}>StandDown</button>
      </div>
      <div className="control-debug">
        <div>pilot: {isPilot ? "yes" : "no"} / srv: {serverStatus?.pilot ? "yes" : "no"}</div>
        <div>target: vx={target.vx.toFixed(2)} vyaw={target.vyaw.toFixed(2)}</div>
        <div>keys: U{+pressed.up} D{+pressed.down} L{+pressed.left} R{+pressed.right}</div>
        <div>last: {serverStatus ? `${serverStatus.lastOp}:${serverStatus.lastCode}` : "--"}</div>
        <div>ack: {lastAck}</div>
        <div>err: {lastError}</div>
      </div>
      <div className="control-hint">Keyboard: Arrow keys (hold)</div>
    </div>
  );
}
