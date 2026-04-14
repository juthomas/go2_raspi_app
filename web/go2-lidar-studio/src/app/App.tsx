import { useEffect, useRef, useState } from "react";
import { SceneCanvas } from "../three/SceneCanvas";
import { useGo2Store } from "../state/useGo2Store";
import { ControlsPanel } from "../ui/panels/ControlsPanel";

export function App() {
  const { state, actions } = useGo2Store();
  const [fpsBins, setFpsBins] = useState<number[]>(() => Array.from({ length: 30 }, () => 0));
  const frameCounterRef = useRef(0);

  useEffect(() => {
    if (!state.lastPayload) return;
    frameCounterRef.current += 1;
  }, [state.lastPayload]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const n = frameCounterRef.current;
      frameCounterRef.current = 0;
      setFpsBins((prev) => [...prev.slice(1), n]);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const currentFps = fpsBins[fpsBins.length - 1] ?? 0;
  const maxFps = Math.max(1, ...fpsBins);

  return (
    <div className="app-shell">
      <aside>
        <h1>GO2 LiDAR Studio</h1>
        <p className="subtitle">Point clouds with history and robot stick model</p>
        <ControlsPanel
          status={state.status}
          statusText={state.statusText}
          settings={state.settings}
          robotState={state.robotState}
          onConnect={actions.connect}
          onDisconnect={actions.disconnect}
          onSettingsChange={actions.updateSettings}
        />
      </aside>

      <main>
        <SceneCanvas payload={state.lastPayload} robotState={state.robotState} settings={state.settings} />
        <div className="fps-debug-overlay">
          <div className="fps-header">WS frames/s: {currentFps}</div>
          <div className="fps-bars">
            {fpsBins.map((v, i) => (
              <span
                key={i}
                className="fps-bar"
                style={{ height: `${Math.max(6, (v / maxFps) * 100)}%` }}
                title={`${v} fps`}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
