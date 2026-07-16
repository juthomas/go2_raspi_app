import { useEffect, useMemo, useState } from "react";

type Props = {
  enabled: boolean;
  controlConnected: boolean;
  controlCanDrive: boolean;
  controlPosturePilot: boolean;
  controlStatusText: string;
  lastAck: string;
  lastError: string;
  serverStatus: {
    lastOp: string;
    lastCode: number;
    pilot: boolean;
    posturePilot: boolean;
    canDrive: boolean;
    connectedClients: number;
    activeController: string | null;
    moveOk: boolean;
    moveHint: string;
    vx: number;
    vy: number;
    vyaw: number;
  } | null;
  debugLogs: string[];
  onClearLogs: () => void;
  onSend: (payload: Record<string, unknown>) => boolean;
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

export function Go2ControlOverlay({
  enabled,
  controlConnected,
  controlCanDrive,
  controlPosturePilot,
  controlStatusText,
  lastAck,
  lastError,
  serverStatus,
  debugLogs,
  onClearLogs,
  onSend,
  speedVx,
  speedVyaw,
}: Props) {
  const [pressed, setPressed] = usePressedState();
  const [copyStatus, setCopyStatus] = useState<string>("");

  const target = useMemo(() => {
    const vx = (pressed.up ? 1 : 0) * speedVx + (pressed.down ? -1 : 0) * speedVx;
    const vyaw = (pressed.left ? 1 : 0) * speedVyaw + (pressed.right ? -1 : 0) * speedVyaw;
    return { vx, vy: 0, vyaw };
  }, [pressed, speedVx, speedVyaw]);

  const moveLabel = useMemo(() => {
    if (!controlConnected) return "move: WS disconnected";
    if (!controlCanDrive) return "move: waiting for bridge status";
    if (serverStatus?.moveOk === false || (serverStatus?.lastCode ?? 0) !== 0) {
      return `move: FAIL code=${serverStatus?.lastCode ?? "?"} (${serverStatus?.moveHint || lastError})`;
    }
    return "move: OK";
  }, [controlCanDrive, controlConnected, lastError, serverStatus]);

  useEffect(() => {
    if (!enabled) {
      setPressed("up", false);
      setPressed("down", false);
      setPressed("left", false);
      setPressed("right", false);
    }
  }, [enabled, setPressed]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
        e.preventDefault();
        setPressed("up", true);
      } else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
        e.preventDefault();
        setPressed("down", true);
      } else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
        e.preventDefault();
        setPressed("left", true);
      } else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
        e.preventDefault();
        setPressed("right", true);
      } else if (e.key === " " || e.key === "x" || e.key === "X") {
        e.preventDefault();
        setPressed("up", false);
        setPressed("down", false);
        setPressed("left", false);
        setPressed("right", false);
        onSend({ type: "stop" });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") setPressed("up", false);
      else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") setPressed("down", false);
      else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") setPressed("left", false);
      else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") setPressed("right", false);
    };
    const onBlur = () => {
      setPressed("up", false);
      setPressed("down", false);
      setPressed("left", false);
      setPressed("right", false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [enabled, onSend, setPressed]);

  useEffect(() => {
    if (!enabled || !controlConnected || !controlCanDrive) return;
    const timer = window.setInterval(() => {
      onSend({
        type: "twist",
        vx: target.vx,
        vy: target.vy,
        vyaw: target.vyaw,
      });
    }, 80);
    return () => window.clearInterval(timer);
  }, [controlCanDrive, controlConnected, enabled, onSend, target]);

  const copyLogs = async () => {
    const payload = debugLogs.length ? debugLogs.join("\n") : "[--] no logs yet";
    try {
      await navigator.clipboard.writeText(payload);
      setCopyStatus("logs copied");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = payload;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        setCopyStatus(ok ? "logs copied" : "copy failed");
      } catch {
        setCopyStatus("copy failed");
      }
    }
    window.setTimeout(() => setCopyStatus(""), 1500);
  };

  return (
    <div className={`control-overlay ${enabled ? "" : "hidden"}`}>
      <div className="control-header">Control WS: {controlStatusText}</div>
      <div className="control-grid">
        <button
          className="btn-fwd"
          onPointerDown={() => setPressed("up", true)}
          onPointerUp={() => setPressed("up", false)}
          onPointerCancel={() => setPressed("up", false)}
          onPointerLeave={() => setPressed("up", false)}
        >
          FWD
        </button>
        <button
          className="btn-left"
          onPointerDown={() => setPressed("left", true)}
          onPointerUp={() => setPressed("left", false)}
          onPointerCancel={() => setPressed("left", false)}
          onPointerLeave={() => setPressed("left", false)}
        >
          LEFT
        </button>
        <button className="btn-stop" onClick={() => onSend({ type: "stop" })}>
          STOP
        </button>
        <button
          className="btn-right"
          onPointerDown={() => setPressed("right", true)}
          onPointerUp={() => setPressed("right", false)}
          onPointerCancel={() => setPressed("right", false)}
          onPointerLeave={() => setPressed("right", false)}
        >
          RIGHT
        </button>
        <button
          className="btn-back"
          onPointerDown={() => setPressed("down", true)}
          onPointerUp={() => setPressed("down", false)}
          onPointerCancel={() => setPressed("down", false)}
          onPointerLeave={() => setPressed("down", false)}
        >
          BACK
        </button>
      </div>
      <div className="control-actions">
        <button onClick={() => onSend({ type: "claim_pilot" })} title="Required for StandUp/Down only">
          ClaimPosturePilot
        </button>
        <button onClick={() => onSend({ type: "normal_mode" })} disabled={!controlPosturePilot}>
          NormalMode
        </button>
        <button onClick={() => onSend({ type: "stand_up" })} disabled={!controlPosturePilot}>
          StandUp
        </button>
        <button onClick={() => onSend({ type: "stand_down" })} disabled={!controlPosturePilot}>
          StandDown
        </button>
        <button onClick={() => onSend({ type: "balance_stand" })} disabled={!controlPosturePilot}>
          BalanceStand
        </button>
        <button onClick={() => onSend({ type: "recovery_stand" })} disabled={!controlPosturePilot}>
          RecoveryStand
        </button>
        <button onClick={onClearLogs}>ClearLogs</button>
        <button onClick={() => void copyLogs()}>CopyLogs</button>
        <button onClick={() => onSend({ type: "front_led", enable: 1 })}>FrontLedOn</button>
        <button onClick={() => onSend({ type: "front_led", enable: 0 })}>FrontLedOff</button>
        <button
          onClick={() => {
            if (window.confirm("Éteindre le Raspberry Pi ?")) {
              onSend({ type: "shutdown_pi" });
            }
          }}
        >
          ShutdownPi
        </button>
      </div>
      <div className="control-debug">
        <div>
          conn: {controlConnected ? "yes" : "no"} drive: {controlCanDrive ? "yes" : "no"} posture pilot:{" "}
          {controlPosturePilot ? "yes" : "no"}
        </div>
        <div className={serverStatus?.moveOk === false ? "control-move-fail" : "control-move-ok"}>{moveLabel}</div>
        <div>
          clients: {serverStatus?.connectedClients ?? 0} active: {serverStatus?.activeController ?? "--"}
        </div>
        <div>target(local): vx={target.vx.toFixed(2)} vyaw={target.vyaw.toFixed(2)}</div>
        <div>
          target(server): vx={serverStatus?.vx?.toFixed(2) ?? "--"} vy={serverStatus?.vy?.toFixed(2) ?? "--"} vyaw=
          {serverStatus?.vyaw?.toFixed(2) ?? "--"}
        </div>
        <div>keys: U{+pressed.up} D{+pressed.down} L{+pressed.left} R{+pressed.right}</div>
        <div>last: {serverStatus ? `${serverStatus.lastOp}:${serverStatus.lastCode}` : "--"}</div>
        <div>ack: {lastAck}</div>
        <div>err: {lastError}</div>
        <div className="control-log-box">
          {(debugLogs.length ? debugLogs : ["[--] no logs yet"]).map((line, idx) => (
            <div key={`${idx}-${line}`}>{line}</div>
          ))}
        </div>
        <div className="control-copy-status">{copyStatus || "\u00a0"}</div>
      </div>
      <div className="control-hint">
        WASD/arrows = drive (no pilot needed). ClaimPosturePilot for StandUp/Down. Ignore send ok — watch move: OK/FAIL.
      </div>
    </div>
  );
}
