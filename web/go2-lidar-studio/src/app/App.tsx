import { useEffect, useRef, useState } from "react";
import { SceneCanvas } from "../three/SceneCanvas";
import { useGo2Store } from "../state/useGo2Store";
import { ControlsPanel } from "../ui/panels/ControlsPanel";
import { Go2WebRtcVideo } from "../video/Go2WebRtcVideo";
import { Go2ControlOverlay } from "../control/Go2ControlOverlay";

const BIN_COUNT = 30;
const LATENCY_CLAMP_MS = 500;

function emptyBins(): number[] {
  return Array.from({ length: BIN_COUNT }, () => 0);
}

function clampLatency(value: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(LATENCY_CLAMP_MS, Math.round(value)));
}

function displayLatency(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} ms` : "--";
}

export function App() {
  const { state, actions } = useGo2Store();
  const [webrtcRttMs, setWebrtcRttMs] = useState<number | null>(null);
  const [piHttpPingMs, setPiHttpPingMs] = useState<number | null>(null);
  const [fpsBins, setFpsBins] = useState<number[]>(() => emptyBins());
  const [latencyBins, setLatencyBins] = useState<{
    lidarWs: number[];
    controlWs: number[];
    webrtc: number[];
    network: number[];
  }>(() => ({
    lidarWs: emptyBins(),
    controlWs: emptyBins(),
    webrtc: emptyBins(),
    network: emptyBins(),
  }));
  const frameCounterRef = useRef(0);
  const wsLatencyRef = useRef<number | null>(null);
  const controlLatencyRef = useRef<number | null>(null);
  const webrtcLatencyRef = useRef<number | null>(null);
  const networkLatencyRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const probe = async () => {
      const t0 = performance.now();
      try {
        const res = await fetch(`${window.location.origin}/?pi_rtt_probe=${Date.now()}`, {
          method: "GET",
          cache: "no-store",
          credentials: "omit",
        });
        if (!cancelled && res.ok) {
          setPiHttpPingMs(Math.max(0, Math.round(performance.now() - t0)));
        } else if (!cancelled) {
          setPiHttpPingMs(null);
        }
      } catch {
        if (!cancelled) setPiHttpPingMs(null);
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void probe();
          }, 2000);
        }
      }
    };

    void probe();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!state.lastPayload) return;
    frameCounterRef.current += 1;
  }, [state.lastPayload]);

  useEffect(() => {
    wsLatencyRef.current = state.wsLatencyMs;
  }, [state.wsLatencyMs]);

  useEffect(() => {
    controlLatencyRef.current = state.controlLatencyMs;
  }, [state.controlLatencyMs]);

  useEffect(() => {
    webrtcLatencyRef.current = webrtcRttMs;
  }, [webrtcRttMs]);

  useEffect(() => {
    networkLatencyRef.current = piHttpPingMs;
  }, [piHttpPingMs]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const n = frameCounterRef.current;
      frameCounterRef.current = 0;
      setFpsBins((prev) => [...prev.slice(1), n]);
      setLatencyBins((prev) => ({
        lidarWs: [...prev.lidarWs.slice(1), clampLatency(wsLatencyRef.current)],
        controlWs: [...prev.controlWs.slice(1), clampLatency(controlLatencyRef.current)],
        webrtc: [...prev.webrtc.slice(1), clampLatency(webrtcLatencyRef.current)],
        network: [...prev.network.slice(1), clampLatency(networkLatencyRef.current)],
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const currentFps = fpsBins[fpsBins.length - 1] ?? 0;
  const maxFps = Math.max(1, ...fpsBins);
  const lidarMax = Math.max(20, ...latencyBins.lidarWs);
  const controlMax = Math.max(20, ...latencyBins.controlWs);
  const webrtcMax = Math.max(20, ...latencyBins.webrtc);
  const networkMax = Math.max(20, ...latencyBins.network);

  return (
    <div className="app-shell">
      <aside>
        <h1>GO2 LiDAR Studio</h1>
        <p className="subtitle">Point clouds with history and robot stick model</p>
        <ControlsPanel
          status={state.status}
          statusText={state.statusText}
          wsLatencyMs={state.wsLatencyMs}
          controlStatus={state.controlStatus}
          controlStatusText={state.controlStatusText}
          controlLatencyMs={state.controlLatencyMs}
          webrtcRttMs={webrtcRttMs}
          piHttpPingMs={piHttpPingMs}
          controlBridgeText={state.controlBridgeText}
          settings={state.settings}
          robotState={state.robotState}
          voxelStatusText={state.voxelStatusText}
          onConnect={actions.connect}
          onDisconnect={actions.disconnect}
          onControlConnect={actions.connectControl}
          onControlDisconnect={actions.disconnectControl}
          onSettingsChange={actions.updateSettings}
          onSendControl={actions.sendControlCommand}
        />
      </aside>

      <main>
        <SceneCanvas
          payload={state.lastPayload}
          voxelPayload={state.lastVoxelPayload}
          robotState={state.robotState}
          settings={state.settings}
        />
        <Go2WebRtcVideo
          enabled={state.settings.webrtcVideoEnabled}
          baseUrl={state.settings.webrtcVideoUrl}
          onRttUpdate={setWebrtcRttMs}
        />
        <Go2ControlOverlay
          enabled={state.settings.controlEnabled}
          controlConnected={state.controlStatus === "connected"}
          controlCanDrive={state.controlCanDrive || state.controlStatus === "connected"}
          controlPosturePilot={state.controlPosturePilot}
          controlStatusText={state.controlStatusText}
          lastAck={state.controlLastAck}
          lastError={state.controlLastError}
          serverStatus={state.controlServerStatus}
          debugLogs={state.controlDebugLogs}
          onClearLogs={actions.clearControlLogs}
          onSend={actions.sendControlCommand}
          speedVx={state.settings.controlSpeedVx}
          speedVyaw={state.settings.controlSpeedVyaw}
        />
        <div className="fps-debug-overlay">
          {/* <div className="fps-header">WS frames/s: {currentFps}</div> */}
          <div className="latency-row-label">
            <span><i className="legend-dot lidar" />LiDAR WS</span>
            <span>{currentFps} fps</span>
          </div>

          <div className="latency-row">
            {fpsBins.map((v, i) => (
              <span
                key={i}
                className="fps-bar"
                style={{ height: `${Math.max(6, (v / maxFps) * 100)}%` }}
                title={`${v} fps`}
              />
            ))}
          </div>
          <div className="latency-row-label">
            <span><i className="legend-dot lidar" />LiDAR WS</span>
            <span>{displayLatency(state.wsLatencyMs)}</span>
          </div>
          <div className="latency-row">
            {latencyBins.lidarWs.map((v, i) => (
              <span
                key={`lidar-${i}`}
                className="latency-bar lidar"
                style={{ height: `${v <= 0 ? 2 : Math.max(6, (v / lidarMax) * 100)}%` }}
                title={`LiDAR WS: ${v} ms`}
              />
            ))}
          </div>
          <div className="latency-row-label">
            <span><i className="legend-dot control" />Control WS</span>
            <span>{displayLatency(state.controlLatencyMs)}</span>
          </div>
          <div className="latency-row">
            {latencyBins.controlWs.map((v, i) => (
              <span
                key={`control-${i}`}
                className="latency-bar control"
                style={{ height: `${v <= 0 ? 2 : Math.max(6, (v / controlMax) * 100)}%` }}
                title={`Control WS: ${v} ms`}
              />
            ))}
          </div>
          <div className="latency-row-label">
            <span><i className="legend-dot webrtc" />Video WebRTC</span>
            <span>{displayLatency(webrtcRttMs)}</span>
          </div>
          <div className="latency-row">
            {latencyBins.webrtc.map((v, i) => (
              <span
                key={`webrtc-${i}`}
                className="latency-bar webrtc"
                style={{ height: `${v <= 0 ? 2 : Math.max(6, (v / webrtcMax) * 100)}%` }}
                title={`WebRTC: ${v} ms`}
              />
            ))}
          </div>
          <div className="latency-row-label">
            <span><i className="legend-dot network" />Pi network</span>
            <span>{displayLatency(piHttpPingMs)}</span>
          </div>
          <div className="latency-row">
            {latencyBins.network.map((v, i) => (
              <span
                key={`network-${i}`}
                className="latency-bar network"
                style={{ height: `${v <= 0 ? 2 : Math.max(6, (v / networkMax) * 100)}%` }}
                title={`Pi network: ${v} ms`}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
