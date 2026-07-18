import { useEffect, useMemo, useRef, useState } from "react";
import type { Go2PointCloudMessage, Go2RobotState, Go2VoxelMapMessage } from "../types/go2";
import { Go2BridgeClient } from "../ws/go2BridgeClient";
import { Go2ControlClient } from "../ws/go2ControlClient";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const POSTURE_COMMANDS = new Set([
  "stand_up",
  "stand_down",
  "balance_stand",
  "recovery_stand",
  "normal_mode",
]);

type ClaimAck = { ok: boolean; msg?: string };

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
  cloudStatusText: string;
  voxelStatusText: string;
  lastCloudRecvMs: number | null;
  lastVoxelRecvMs: number | null;
  robotState: Go2RobotState | null;
  settings: UiSettings;
};

const CONTROL_LOG_LIMIT = 2000;
const STREAM_ALIVE_S = 2.5;
const STREAM_STALE_S = 10;
const nowTag = (): string => new Date().toLocaleTimeString();
const appendLog = (logs: string[], line: string): string[] => {
  const next = [...logs, `[${nowTag()}] ${line}`];
  return next.length > CONTROL_LOG_LIMIT ? next.slice(next.length - CONTROL_LOG_LIMIT) : next;
};

function formatStreamStatus(
  label: string,
  lastRecvMs: number | null,
  opts: { connected: boolean; emptyHint?: string },
): string {
  if (!opts.connected) return `${label}: offline`;
  if (lastRecvMs == null) return `${label}: waiting for frames…`;
  const ageS = Math.max(0, (performance.now() - lastRecvMs) / 1000);
  if (ageS <= STREAM_ALIVE_S) return `${label}: alive (${ageS.toFixed(1)}s)`;
  if (ageS <= STREAM_STALE_S) return `${label}: stale (${ageS.toFixed(0)}s)`;
  return `${label}: dead (${ageS.toFixed(0)}s)${opts.emptyHint ? ` — ${opts.emptyHint}` : ""}`;
}

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

function defaultVideoUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:8081`;
}

function sanitizeVideoUrl(raw: string | undefined): string {
  const fallback = defaultVideoUrl();
  const value = (raw ?? "").trim() || fallback;
  try {
    const parsed = new URL(value);
    const appHost = window.location.hostname;
    const appIsRemote = appHost !== "localhost" && appHost !== "127.0.0.1";
    const urlIsLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (appIsRemote && urlIsLoopback) {
      parsed.hostname = appHost;
      return parsed.toString().replace(/\/$/, "");
    }
    return value.replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function loadSettings(): UiSettings {
  const defaultControlWsUrl = Go2ControlClient.defaultUrl();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return {
        ...DEFAULT_SETTINGS,
        wsUrl: Go2BridgeClient.defaultUrl(),
        webrtcVideoUrl: defaultVideoUrl(),
        controlWsUrl: defaultControlWsUrl,
      };
    }
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    const merged = {
      ...DEFAULT_SETTINGS,
      wsUrl: Go2BridgeClient.defaultUrl(),
      webrtcVideoUrl: defaultVideoUrl(),
      controlWsUrl: defaultControlWsUrl,
      ...parsed,
    };
    merged.webrtcVideoUrl = sanitizeVideoUrl(merged.webrtcVideoUrl);
    return merged;
  } catch {
    return {
      ...DEFAULT_SETTINGS,
      wsUrl: Go2BridgeClient.defaultUrl(),
      webrtcVideoUrl: defaultVideoUrl(),
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
    cloudStatusText: "Cloud: --",
    voxelStatusText: "Map: --",
    lastCloudRecvMs: null,
    lastVoxelRecvMs: null,
    robotState: null,
    settings: loadSettings(),
  }));

  const claimWaitersRef = useRef<Array<(ack: ClaimAck) => void>>([]);
  const postureBusyRef = useRef(false);
  const controlSnapshotRef = useRef({
    status: "disconnected" as ConnectionStatus,
    posturePilot: false,
  });
  controlSnapshotRef.current = {
    status: state.controlStatus,
    posturePilot: state.controlPosturePilot,
  };

  const client = useMemo(
    () =>
      new Go2BridgeClient({
        onOpen: () => {
          setState((prev) => ({
            ...prev,
            status: "connected",
            statusText: "LiDAR WS connected",
            wsLatencyMs: null,
            cloudStatusText: formatStreamStatus("Cloud", prev.lastCloudRecvMs, {
              connected: true,
            }),
            voxelStatusText: formatStreamStatus("Map", prev.lastVoxelRecvMs, {
              connected: true,
              emptyHint: "start Unitree mapping recording",
            }),
          }));
        },
        onClose: (_code, reason) => {
          setState((prev) => ({
            ...prev,
            status: "disconnected",
            statusText: `LiDAR WS closed (${reason || "closed"})`,
            wsLatencyMs: null,
            cloudStatusText: "Cloud: offline",
            voxelStatusText: "Map: offline",
          }));
        },
        onError: (message) => {
          const reconnecting = message.includes("LiDAR WS reconnect");
          setState((prev) => ({
            ...prev,
            status: reconnecting ? "connecting" : "error",
            statusText: message,
          }));
        },
        onHello: (msg) => {
          if (msg.type !== "hello") return;
          const mapSrc = msg.voxel_map_source ?? (msg.voxel_enabled ? "on" : "off");
          const cloudN = typeof msg.cloud_frames === "number" ? msg.cloud_frames : null;
          const mapN = typeof msg.map_frames === "number" ? msg.map_frames : null;
          const bits = [
            `topic ${msg.topic}`,
            msg.voxel_enabled ? `map=${mapSrc}` : null,
            cloudN != null ? `cloud_frames=${cloudN}` : null,
            mapN != null ? `map_frames=${mapN}` : null,
          ].filter(Boolean);
          setState((prev) => ({
            ...prev,
            statusText: `Bridge: ${bits.join(" | ")}`,
          }));
        },
        onPointCloud: (msg) => {
          const now = performance.now();
          setState((prev) => ({
            ...prev,
            lastPayload: msg,
            lastCloudRecvMs: now,
            robotState: msg.robot_state ?? prev.robotState,
            cloudStatusText: formatStreamStatus("Cloud", now, { connected: true }),
          }));
        },
        onVoxelMap: (msg) => {
          const n = Array.isArray(msg.occupied_points) ? msg.occupied_points.length : 0;
          const res = typeof msg.resolution === "number" ? msg.resolution.toFixed(2) : "?";
          const note = msg.decode_note ? ` (${msg.decode_note})` : "";
          const src = typeof msg.map_source === "string" ? msg.map_source : "map";
          const now = performance.now();
          setState((prev) => ({
            ...prev,
            lastVoxelPayload: msg,
            lastVoxelRecvMs: now,
            robotState: msg.robot_state ?? prev.robotState,
            voxelStatusText:
              n > 0
                ? `Map (${src}): alive — ${n.toLocaleString()} pts, res ${res}m`
                : `Map (${src}): alive — metadata only${note}`,
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
      if (typeof patch.webrtcVideoUrl === "string") {
        next.webrtcVideoUrl = sanitizeVideoUrl(patch.webrtcVideoUrl);
      }
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
    setState((prev) => ({
      ...prev,
      status: "disconnected",
      statusText: "Disconnected",
      wsLatencyMs: null,
      cloudStatusText: "Cloud: offline",
      voxelStatusText: "Map: offline",
    }));
  };

  // Refresh cloud/map alive/stale labels while connected.
  useEffect(() => {
    if (state.status !== "connected") return;
    const timer = window.setInterval(() => {
      setState((prev) => {
        if (prev.status !== "connected") return prev;
        const cloud = formatStreamStatus("Cloud", prev.lastCloudRecvMs, { connected: true });
        const mapPts = Array.isArray(prev.lastVoxelPayload?.occupied_points)
          ? prev.lastVoxelPayload.occupied_points.length
          : 0;
        // Keep rich map label when frames are fresh with points.
        const mapAgeMs =
          prev.lastVoxelRecvMs == null ? null : performance.now() - prev.lastVoxelRecvMs;
        const mapFresh = mapAgeMs != null && mapAgeMs / 1000 <= STREAM_ALIVE_S;
        const map =
          mapFresh && mapPts > 0
            ? prev.voxelStatusText
            : formatStreamStatus("Map", prev.lastVoxelRecvMs, {
                connected: true,
                emptyHint: "start Unitree mapping recording",
              });
        if (cloud === prev.cloudStatusText && map === prev.voxelStatusText) return prev;
        return { ...prev, cloudStatusText: cloud, voxelStatusText: map };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state.status]);

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
          if (msg.cmd === "claim_pilot") {
            const waiters = claimWaitersRef.current.splice(0);
            for (const resolve of waiters) {
              resolve({ ok: Boolean(msg.ok), msg: msg.msg });
            }
          }
          const text = `${msg.cmd ?? "?"}: ${msg.ok ? "ok" : "fail"}${msg.msg ? ` (${msg.msg})` : ""}`;
          setState((prev) => {
            const isTwist = msg.cmd === "twist";
            const isZeroTwist =
              isTwist && typeof msg.msg === "string" && msg.msg.includes("target=(+0.00,+0.00,+0.00)");
            const isPosture =
              msg.cmd === "stand_up" ||
              msg.cmd === "stand_down" ||
              msg.cmd === "balance_stand" ||
              msg.cmd === "recovery_stand" ||
              msg.cmd === "normal_mode";
            const logs =
              isTwist && isZeroTwist
                ? prev.controlDebugLogs
                : appendLog(prev.controlDebugLogs, `ack ${text}`);
            return {
              ...prev,
              controlLastAck: text,
              controlPosturePilot:
                msg.cmd === "claim_pilot"
                  ? Boolean(msg.ok)
                  : msg.cmd === "release_pilot"
                    ? false
                    : prev.controlPosturePilot,
              controlPilot:
                msg.cmd === "claim_pilot"
                  ? Boolean(msg.ok)
                  : msg.cmd === "release_pilot"
                    ? false
                    : prev.controlPilot,
              controlStatusText:
                msg.cmd === "claim_pilot"
                  ? msg.ok
                    ? "Posture pilot granted (StandUp/Down)"
                    : "Posture pilot denied"
                  : isPosture
                    ? msg.ok
                      ? `${msg.cmd}: OK`
                      : `${msg.cmd}: FAIL`
                    : prev.controlStatusText,
              controlLastError: msg.ok ? prev.controlLastError : msg.msg ?? "command failed",
              controlDebugLogs: logs,
            };
          });
        },
        onStatus: (msg) => {
          setState((prev) => {
            const youArePilot =
              typeof msg.you_are_posture_pilot === "boolean"
                ? msg.you_are_posture_pilot
                : Boolean(msg.posture_pilot ?? msg.pilot);
            const someonePilot = Boolean(msg.posture_pilot ?? msg.pilot);
            const nextStatus = {
              lastOp: msg.last_op ?? "?",
              lastCode: Number(msg.last_code ?? 0),
              pilot: someonePilot,
              posturePilot: youArePilot,
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
            const pilotChanged =
              !prevStatus ||
              prevStatus.posturePilot !== nextStatus.posturePilot ||
              prevStatus.pilot !== nextStatus.pilot ||
              prevStatus.canDrive !== nextStatus.canDrive;
            const moveChanged =
              !prevStatus ||
              prevStatus.lastOp !== nextStatus.lastOp ||
              prevStatus.lastCode !== nextStatus.lastCode ||
              prevStatus.moveOk !== nextStatus.moveOk ||
              prevStatus.connectedClients !== nextStatus.connectedClients;
            let logs = prev.controlDebugLogs;
            if (pilotChanged) {
              logs = appendLog(
                logs,
                `status pilot you=${nextStatus.posturePilot ? "yes" : "no"} someone=${nextStatus.pilot ? "yes" : "no"} drive=${nextStatus.canDrive ? "yes" : "no"} clients=${nextStatus.connectedClients}`,
              );
            }
            if (moveChanged && (nextStatus.lastCode !== 0 || nextStatus.lastOp.includes("move"))) {
              logs = appendLog(
                logs,
                `status op=${nextStatus.lastOp} code=${nextStatus.lastCode} move=${nextStatus.moveOk ? "OK" : "FAIL"} target=(${nextStatus.vx.toFixed(2)},${nextStatus.vy.toFixed(2)},${nextStatus.vyaw.toFixed(2)})`,
              );
            }
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
    controlClient.send({ type: "stop" });
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

  const waitClaimAck = (timeoutMs = 3000): Promise<ClaimAck> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (ack: ClaimAck) => {
        if (settled) return;
        settled = true;
        resolve(ack);
      };
      claimWaitersRef.current.push(finish);
      window.setTimeout(() => {
        const idx = claimWaitersRef.current.indexOf(finish);
        if (idx >= 0) claimWaitersRef.current.splice(idx, 1);
        finish({ ok: false, msg: "claim_pilot timeout — posture aborted" });
      }, timeoutMs);
    });

  const sendPostureCommand = async (type: string): Promise<boolean> => {
    const typ = String(type || "");
    if (!POSTURE_COMMANDS.has(typ)) {
      return sendControlCommand({ type: typ });
    }

    const snap = controlSnapshotRef.current;
    setState((prev) => ({
      ...prev,
      controlDebugLogs: appendLog(
        prev.controlDebugLogs,
        `ui click ${typ} (pilot=${snap.posturePilot ? "yes" : "no"} connected=${snap.status === "connected" ? "yes" : "no"})`,
      ),
    }));

    if (snap.status !== "connected") {
      setState((prev) => ({
        ...prev,
        controlLastError: "Control WS not connected",
        controlDebugLogs: appendLog(prev.controlDebugLogs, `send fail ${typ}: Control WS not connected`),
      }));
      return false;
    }

    if (postureBusyRef.current) {
      setState((prev) => ({
        ...prev,
        controlDebugLogs: appendLog(
          prev.controlDebugLogs,
          `ui click ${typ} ignored — posture command already in flight`,
        ),
      }));
      return false;
    }

    postureBusyRef.current = true;
    try {
      if (!controlSnapshotRef.current.posturePilot) {
        setState((prev) => ({
          ...prev,
          controlDebugLogs: appendLog(prev.controlDebugLogs, `auto claim_pilot before ${typ}`),
        }));
        const claimSent = controlClient.send({ type: "claim_pilot" });
        setState((prev) => ({
          ...prev,
          controlDebugLogs: appendLog(
            prev.controlDebugLogs,
            claimSent ? `send claim_pilot {}` : `send fail claim_pilot`,
          ),
        }));
        if (!claimSent) {
          setState((prev) => ({
            ...prev,
            controlLastError: "Control WS not connected",
          }));
          return false;
        }
        const claimAck = await waitClaimAck(3500);
        if (!claimAck.ok) {
          setState((prev) => ({
            ...prev,
            controlLastError: claimAck.msg ?? "claim_pilot failed",
            controlDebugLogs: appendLog(
              prev.controlDebugLogs,
              `claim_pilot failed — ${typ} aborted (${claimAck.msg ?? "denied"})`,
            ),
          }));
          return false;
        }
      }

      const ok = controlClient.send({ type: typ });
      setState((prev) => ({
        ...prev,
        controlDebugLogs: appendLog(
          prev.controlDebugLogs,
          ok ? `send ${typ} {}` : `send fail ${typ}`,
        ),
        controlLastError: ok ? prev.controlLastError : "Control WS not connected",
      }));
      return ok;
    } finally {
      postureBusyRef.current = false;
    }
  };

  return {
    state,
    actions: {
      connect,
      disconnect,
      connectControl,
      disconnectControl,
      sendControlCommand,
      sendPostureCommand,
      clearControlLogs: () => setState((prev) => ({ ...prev, controlDebugLogs: [] })),
      updateSettings,
      clearSceneData: () => setState((prev) => ({ ...prev, lastPayload: null })),
    },
  };
}
