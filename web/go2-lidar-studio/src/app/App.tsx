import { SceneCanvas } from "../three/SceneCanvas";
import { useGo2Store } from "../state/useGo2Store";
import { ControlsPanel } from "../ui/panels/ControlsPanel";

export function App() {
  const { state, actions } = useGo2Store();

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
      </main>
    </div>
  );
}
