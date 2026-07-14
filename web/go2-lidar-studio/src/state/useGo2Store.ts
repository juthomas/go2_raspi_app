import { useMemo, useState } from "react";
import type { Go2PointCloudMessage, Go2RobotState, Go2VoxelMapMessage } from "../types/go2";
import { Go2BridgeClient } from "../ws/go2BridgeClient";
import { Go2ControlClient } from "../ws/go2ControlClient";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type UiSettings = {
  wsUrl: string;
  webrtcVideoEnabled: boolean;
  webrtcVideoUrl: string;
  controlEnabled: boolean;
  controlWsUrl: string;
  controlSpeedVx: number;
  controlSpeedVyaw: number;
  pointSize: number;
  maxPoints: number;
  historyRetentionSec: number;
  currentColor: string;
  historyColor: string;
  showHistory: boolean;
  showRobot: boolean;
  robotScale: number;
  showTrail: boolean;
  envScale: number;
  envOffsetX: number;
  envOffsetY: number;
  envOffsetZ: number;
  showGrid: boolean;
  showAxes: boolean;
  followRobot: boolean;
  showVoxel: boolean;
  voxelColor: string;
  voxelMaxPoints: number;
};

type StoreState = {
  status: ConnectionStatus;
  statusText: string;
  wsLatencyMs: number | null;
  controlStatus: ConnectionStatus;
  controlStatusText: string;
  controlLatencyMs: number | null;
  controlBridgeText: string;
  controlPilot: boolean;
  controlPosturePilot: boolean;
  controlCanDrive: boolean;
  controlLastAck: string;
  controlLastError: string;
  controlServerStatus: {
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
  controlDebugLogs: string[];
  lastPayload: Go2PointCloudMessage | null;
  lastVoxelPayload: Go2VoxelMapMessage | null;
  voxelStatusText: string;
  robotState: Go2RobotState | null;
  settings: UiSettings;
};

const CONTROL_LOG_LIMIT = 2000;
const nowTag = (): string => new Date().toLocaleTimeString();
const appendLog = (logs: string[], line: string): string[] => {
  const next = [...logs, `[${nowTag()}] ${line}`];
  return next.length > CONTROL_LOG_LIMIT ? next.slice(next.length - CONTROL_LOG_LIMIT) : next;
};

const SETTINGS_KEY = "go2_lidar_studio_settings_v1";

const DEFAULT_SETTINGS: UiSettings = {
  wsUrl: "",
  webrtcVideoEnabled: false,
  webrtcVideoUrl: "",
  controlEnabled: false,
  controlWsUrl: "",
  controlSpeedVx: 0.25,
  controlSpeedVyaw: 0.7,
  pointSize: 0.08,
  maxPoints: 25000,
  historyRetentionSec: 2.5,
  currentColor: "#00ff99",
  historyColor: "#ff8844",
  showHistory: true,
  showRobot: true,
  robotScale: 1,
  showTrail: true,
  envScale: 1,
  envOffsetX: 0,
  envOffsetY: 0,
  envOffsetZ: 0,
  showGrid: true,
  showAxes: true,
  followRobot: false,
  showVoxel: false,
  voxelColor: "#8888ff",
  voxelMaxPoints: 30000,
};

function loadSettings(): UiSettings {
  const defaultControlWsUrl = Go2ControlClient.defaultUrl();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return {
        ...DEFAULT_SETTINGS,
        wsUrl: Go2BridgeClient.defaultUrl(),
        webrtcVideoUrl: `${window.location.protocol}//${window.location.hostname}:8081`,
        controlWsUrl: defaultControlWsUrl,
      };
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return {
      ...DEFAULT_SETTINGS,
      wsUrl: Go2BridgeClient.defaultUrl(),
      webrtcVideoUrl: `${window.location.protocol}//${window.location.hostname}:8081`,
      controlWsUrl: defaultControlWsUrl,
      ...parsed,
    };
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      wsUrl: Go2BridgeClient.defaultUrl(),
      webrtcVideoUrl: `${window.location.protocol}//${window.location.hostname}:8081`,
      controlWsUrl: defaultControlWsUrl,
    };
  }
}

export function useGo2Store() {
  const [state, setState] = useState<StoreState>(() => ({
    status: "disconnected",
    statusText: "Idle",
    wsLatencyMs: null,
    controlStatus: "disconnected",
    controlStatusText: "Control WS idle",
    controlLatencyMs: null,
    controlBridgeText: "Control bridge: --",
    controlPilot: false,
    controlPosturePilot: false,
    controlCanDrive: false,
    controlLastAck: "--",
    controlLastError: "--",
    controlServerStatus: null,
    controlDebugLogs: [],
    lastPayload: null,
    lastVoxelPayload: null,
    voxelStatusText: "Voxel: --",
    robotState: null,
    settings: loadSettings(),
  }));

  const client = useMemo(
    () =>
      new Go2BridgeClient({
        onOpen: () => {
          setState((prev) => ({ ...prev, status: "connected", statusText: "WebSocket connected", wsLatencyMs: null }));
        },
        onClose: () => {
          setState((prev) => ({
            ...prev,
            status: "disconnected",
            statusText: "WebSocket closed",
            wsLatencyMs: null,
          }));
        },
        onError: (message) => {
          setState((prev) => ({ ...prev, status: "error", statusText: message }));
        },
        onHello: (msg) => {
          if (msg.type !== "hello") return;
          const voxelHint = msg.voxel_enabled ? ` | voxel: ${msg.voxel_topic ?? "on"}` : "";
          setState((prev) => ({
            ...prev,
            statusText: `Bridge topic: ${msg.topic}${voxelHint}`,
          }));
        },
        onPointCloud: (msg) => {
          setState((prev) => ({
            ...prev,
            lastPayload: msg,
            robotState: msg.robot_state ?? prev.robotState,
          }));
        },
        onVoxelMap: (msg) => {
          const n = Array.isArray(msg.occupied_points) ? msg.occupied_points.length : 0;
          const res = typeof msg.resolution === "number" ? msg.resolution.toFixed(2) : "?";
          const note = msg.decode_note ? ` (${msg.decode_note})` : "";
          setState((prev) => ({
            ...prev,
            lastVoxelPayload: msg,
            robotState: msg.robot_state ?? prev.robotState,
            voxelStatusText:
              n > 0
                ? `Voxel: ${n.toLocaleString()} pts, res ${res}m`
                : `Voxel: metadata only${note}`,
          }));
        },
        onLatency: (latencyMs) => {
          setState((prev) => ({ ...prev, wsLatencyMs: latencyMs }));
        },
      }),
    [],
  );

  const saveSettings = (next: UiSettings): void => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Ignore localStorage errors.
    }
  };

  const updateSettings = (patch: Partial<UiSettings>) => {
    setState((prev) => {
      const next = { ...prev.settings, ...patch };
      saveSettings(next);
      return { ...prev, settings: next };
    });
    if (patch.controlEnabled === false) {
      controlClient.disconnect();
      setState((prev) => ({
        ...prev,
        controlStatus: "disconnected",
        controlStatusText: "Control WS disconnected",
        controlPilot: false,
        controlPosturePilot: false,
        controlCanDrive: false,
        controlDebugLogs: appendLog(prev.controlDebugLogs, "control feature disabled"),
      }));
    }
  };

  const connect = () => {
    setState((prev) => ({ ...prev, status: "connecting", statusText: "Connecting..." }));
    client.connect(state.settings.wsUrl.trim());
  };

  const disconnect = () => {
    client.disconnect();
    setState((prev) => ({ ...prev, status: "disconnected", statusText: "Disconnected", wsLatencyMs: null }));
  };

  const controlClient = useMemo(
    () =>
      new Go2ControlClient({
        onOpen: () => {
          setState((prev) => ({
            ...prev,
            controlStatus: "connected",
            controlStatusText: "Control WS connected",
            controlLatencyMs: null,
            controlCanDrive: true,
            controlLastError: "--",
            controlDebugLogs: appendLog(prev.controlDebugLogs, "socket open"),
          }));
        },
        onClose: (code, reason) => {
          setState((prev) => ({
            ...prev,
            controlStatus: "disconnected",
            controlStatusText: `Control WS closed (${code})`,
            controlLatencyMs: null,
            controlPilot: false,
            controlPosturePilot: false,
            controlCanDrive: false,
            controlLastError: reason || prev.controlLastError,
            controlDebugLogs: appendLog(prev.controlDebugLogs, `socket closed code=${code} reason=${reason || "--"}`),
          }));
        },
        onError: (message) => {
          setState((prev) => ({
            ...prev,
            controlStatus: "error",
            controlStatusText: message.startsWith("Control WS reconnect")
              ? message
              : "Control WS error",
            controlLatencyMs: null,
            controlLastError: message,
            controlDebugLogs: appendLog(prev.controlDebugLogs, `client error: ${message}`),
          }));
        },
        onHello: (msg) => {
          setState((prev) => ({
            ...prev,
            controlStatusText: "Control WS connected",
            controlBridgeText: `Bridge topic: control (${msg.bridge ?? "go2_control_ws_bridge"}, iface ${
              msg.iface ?? "?"
            })`,
            controlDebugLogs: appendLog(
              prev.controlDebugLogs,
              `hello bridge=${msg.bridge ?? "?"} iface=${msg.iface ?? "?"} proto=${msg.protocol ?? "?"}`,
            ),
          }));
        },
        onAck: (msg) => {
          const text = `${msg.cmd ?? "?"}: ${msg.ok ? "ok" : "fail"}${msg.msg ? ` (${msg.msg})` : ""}`;
          setState((prev) => {
            const isTwist = msg.cmd === "twist";
            const isZeroTwist =
              isTwist && typeof msg.msg === "string" && msg.msg.includes("target=(+0.00,+0.00,+0.00)");
            const logs =
              isTwist && isZeroTwist
                ? prev.controlDebugLogs
                : appendLog(prev.controlDebugLogs, `ack ${text}`);
            return {
              ...prev,
              controlLastAck: text,
              controlPosturePilot: msg.cmd === "claim_pilot" ? Boolean(msg.ok) : prev.controlPosturePilot,
              controlPilot: msg.cmd === "claim_pilot" ? Boolean(msg.ok) : prev.controlPilot,
              controlStatusText:
                msg.cmd === "claim_pilot"
                  ? msg.ok
                    ? "Posture pilot granted (StandUp/Down)"
                    : "Posture pilot denied"
                  : prev.controlStatusText,
              controlLastError: msg.ok ? prev.controlLastError : msg.msg ?? "command failed",
              controlDebugLogs: logs,
            };
          });
        },
        onStatus: (msg) => {
          setState((prev) => {
            const nextStatus = {
              lastOp: msg.last_op ?? "?",
              lastCode: Number(msg.last_code ?? 0),
              pilot: Boolean(msg.pilot),
              posturePilot: Boolean(msg.posture_pilot ?? msg.pilot),
              canDrive: Boolean(msg.can_drive ?? msg.connected_clients),
              connectedClients: Number(msg.connected_clients ?? 0),
              activeController: msg.active_controller ?? null,
              moveOk: Boolean(msg.move_ok ?? msg.last_code === 0),
              moveHint: String(msg.move_hint ?? msg.last_error ?? ""),
              vx: Number(msg.vx ?? 0),
              vy: Number(msg.vy ?? 0),
              vyaw: Number(msg.vyaw ?? 0),
            };
            const prevStatus = prev.controlServerStatus;
            const changed =
              !prevStatus ||
              prevStatus.lastOp !== nextStatus.lastOp ||
              prevStatus.lastCode !== nextStatus.lastCode ||
              prevStatus.moveOk !== nextStatus.moveOk ||
              prevStatus.connectedClients !== nextStatus.connectedClients;
            const logs =
              changed && (nextStatus.lastCode !== 0 || nextStatus.lastOp.includes("move"))
                ? appendLog(
                    prev.controlDebugLogs,
                    `status op=${nextStatus.lastOp} code=${nextStatus.lastCode} move=${nextStatus.moveOk ? "OK" : "FAIL"} target=(${nextStatus.vx.toFixed(2)},${nextStatus.vy.toFixed(2)},${nextStatus.vyaw.toFixed(2)})`,
                  )
                : prev.controlDebugLogs;
            return {
              ...prev,
              controlServerStatus: nextStatus,
              controlPosturePilot: nextStatus.posturePilot,
              controlPilot: nextStatus.posturePilot,
              controlCanDrive: nextStatus.canDrive,
              controlLastError:
                nextStatus.lastCode !== 0 ? nextStatus.moveHint || prev.controlLastError : prev.controlLastError,
              controlDebugLogs: logs,
            };
          });
        },
        onRobotError: (msg) => {
          const line = `robot_error op=${msg.op ?? "?"} code=${msg.code ?? "?"} hint=${msg.hint ?? "--"}`;
          setState((prev) => ({
            ...prev,
            controlLastError: msg.hint ?? prev.controlLastError,
            controlDebugLogs: appendLog(prev.controlDebugLogs, line),
          }));
        },
        onServerError: (msg) => {
          setState((prev) => ({
            ...prev,
            controlLastError: msg.msg ?? "unknown bridge error",
            controlDebugLogs: appendLog(prev.controlDebugLogs, `server error: ${msg.msg ?? "unknown bridge error"}`),
          }));
        },
        onServerLog: (msg) => {
          setState((prev) => ({
            ...prev,
            controlDebugLogs: appendLog(
              prev.controlDebugLogs,
              `server ${msg.level ?? "info"}: ${msg.msg ?? "--"}`,
            ),
          }));
        },
        onLatency: (latencyMs) => {
          setState((prev) => ({ ...prev, controlLatencyMs: latencyMs }));
        },
      }),
    [],
  );

  const connectControl = () => {
    setState((prev) => ({
      ...prev,
      controlStatus: "connecting",
      controlStatusText: "Connecting control WS...",
      controlLastAck: "--",
      controlLastError: "--",
      controlDebugLogs: appendLog(prev.controlDebugLogs, `connect request url=${state.settings.controlWsUrl.trim()}`),
    }));
    controlClient.connect(state.settings.controlWsUrl.trim());
  };

  const disconnectControl = () => {
    controlClient.send({ type: "release_pilot" });
    controlClient.disconnect();
    setState((prev) => ({
      ...prev,
      controlStatus: "disconnected",
      controlStatusText: "Control WS disconnected",
      controlLatencyMs: null,
      controlPilot: false,
      controlPosturePilot: false,
      controlCanDrive: false,
      controlDebugLogs: appendLog(prev.controlDebugLogs, "disconnect request"),
    }));
  };

  const sendControlCommand = (payload: Record<string, unknown>) => {
    const ok = controlClient.send(payload);
    const typ = String(payload.type ?? "");
    const isIdleTwist =
      typ === "twist" &&
      Number(payload.vx ?? 0) === 0 &&
      Number(payload.vy ?? 0) === 0 &&
      Number(payload.vyaw ?? 0) === 0;
    if (!ok || typ !== "twist" || !isIdleTwist) {
      setState((prev) => ({
        ...prev,
        controlDebugLogs: appendLog(
          prev.controlDebugLogs,
          ok ? `send ${typ} ${JSON.stringify(payload)}` : `send fail ${JSON.stringify(payload)}`,
        ),
      }));
    }
    if (!ok) {
      setState((prev) => ({
        ...prev,
        controlLastError: "Control WS not connected",
      }));
    }
    return ok;
  };

  return {
    state,
    actions: {
      connect,
      disconnect,
      connectControl,
      disconnectControl,
      sendControlCommand,
      clearControlLogs: () => setState((prev) => ({ ...prev, controlDebugLogs: [] })),
      updateSettings,
      clearSceneData: () => setState((prev) => ({ ...prev, lastPayload: null })),
    },
  };
}
