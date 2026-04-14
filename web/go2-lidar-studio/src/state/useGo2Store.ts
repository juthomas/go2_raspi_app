import { useMemo, useState } from "react";
import type { Go2PointCloudMessage, Go2RobotState } from "../types/go2";
import { Go2BridgeClient } from "../ws/go2BridgeClient";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type UiSettings = {
  wsUrl: string;
  pointSize: number;
  maxPoints: number;
  historyRetentionSec: number;
  currentColor: string;
  historyColor: string;
  showHistory: boolean;
  showRobot: boolean;
  robotScale: number;
  showTrail: boolean;
  showGrid: boolean;
  showAxes: boolean;
  followRobot: boolean;
};

type StoreState = {
  status: ConnectionStatus;
  statusText: string;
  lastPayload: Go2PointCloudMessage | null;
  robotState: Go2RobotState | null;
  settings: UiSettings;
};

const SETTINGS_KEY = "go2_lidar_studio_settings_v1";

const DEFAULT_SETTINGS: UiSettings = {
  wsUrl: "",
  pointSize: 0.08,
  maxPoints: 25000,
  historyRetentionSec: 2.5,
  currentColor: "#00ff99",
  historyColor: "#ff8844",
  showHistory: true,
  showRobot: true,
  robotScale: 1,
  showTrail: true,
  showGrid: true,
  showAxes: true,
  followRobot: false,
};

function loadSettings(): UiSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, wsUrl: Go2BridgeClient.defaultUrl() };
    const parsed = JSON.parse(raw) as Partial<UiSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS, wsUrl: Go2BridgeClient.defaultUrl() };
  }
}

export function useGo2Store() {
  const [state, setState] = useState<StoreState>(() => ({
    status: "disconnected",
    statusText: "Idle",
    lastPayload: null,
    robotState: null,
    settings: loadSettings(),
  }));

  const client = useMemo(
    () =>
      new Go2BridgeClient({
        onOpen: () => {
          setState((prev) => ({ ...prev, status: "connected", statusText: "WebSocket connected" }));
        },
        onClose: () => {
          setState((prev) => ({
            ...prev,
            status: "disconnected",
            statusText: "WebSocket closed",
          }));
        },
        onError: (message) => {
          setState((prev) => ({ ...prev, status: "error", statusText: message }));
        },
        onHello: (msg) => {
          if (msg.type !== "hello") return;
          setState((prev) => ({
            ...prev,
            statusText: `Bridge topic: ${msg.topic}`,
          }));
        },
        onPointCloud: (msg) => {
          setState((prev) => ({
            ...prev,
            lastPayload: msg,
            robotState: msg.robot_state ?? prev.robotState,
          }));
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
  };

  const connect = () => {
    setState((prev) => ({ ...prev, status: "connecting", statusText: "Connecting..." }));
    client.connect(state.settings.wsUrl.trim());
  };

  const disconnect = () => {
    client.disconnect();
    setState((prev) => ({ ...prev, status: "disconnected", statusText: "Disconnected" }));
  };

  return {
    state,
    actions: {
      connect,
      disconnect,
      updateSettings,
      clearSceneData: () => setState((prev) => ({ ...prev, lastPayload: null })),
    },
  };
}
