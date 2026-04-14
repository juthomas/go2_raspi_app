import type { UiSettings } from "../../state/useGo2Store";
import type { ConnectionStatus } from "../../state/useGo2Store";
import type { Go2RobotState } from "../../types/go2";

type Props = {
  status: ConnectionStatus;
  statusText: string;
  settings: UiSettings;
  robotState: Go2RobotState | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onSettingsChange: (patch: Partial<UiSettings>) => void;
};

export function ControlsPanel({
  status,
  statusText,
  settings,
  robotState,
  onConnect,
  onDisconnect,
  onSettingsChange,
}: Props) {
  return (
    <div className="controls-panel">
      <section>
        <h3>Connection</h3>
        <label>
          Bridge WS URL
          <input
            value={settings.wsUrl}
            onChange={(e) => onSettingsChange({ wsUrl: e.target.value })}
            placeholder="ws://127.0.0.1:8765"
          />
        </label>
        <div className="row">
          <button onClick={onConnect} disabled={status === "connecting"}>
            Connect
          </button>
          <button onClick={onDisconnect}>Disconnect</button>
        </div>
        <p className={`status ${status}`}>{statusText}</p>
      </section>

      <section>
        <h3>LiDAR</h3>
        <label>
          Point size ({settings.pointSize.toFixed(2)})
          <input
            type="range"
            min={0.02}
            max={0.3}
            step={0.01}
            value={settings.pointSize}
            onChange={(e) => onSettingsChange({ pointSize: Number(e.target.value) })}
          />
        </label>
        <label>
          Point budget ({settings.maxPoints})
          <input
            type="range"
            min={1000}
            max={50000}
            step={1000}
            value={settings.maxPoints}
            onChange={(e) => onSettingsChange({ maxPoints: Number(e.target.value) })}
          />
        </label>
        <label>
          History retention ({settings.historyRetentionSec.toFixed(1)}s)
          <input
            type="range"
            min={0.2}
            max={15}
            step={0.1}
            value={settings.historyRetentionSec}
            onChange={(e) => onSettingsChange({ historyRetentionSec: Number(e.target.value) })}
          />
        </label>
        <label>
          Current color
          <input
            type="color"
            value={settings.currentColor}
            onChange={(e) => onSettingsChange({ currentColor: e.target.value })}
          />
        </label>
        <label>
          History color
          <input
            type="color"
            value={settings.historyColor}
            onChange={(e) => onSettingsChange({ historyColor: e.target.value })}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showHistory}
            onChange={(e) => onSettingsChange({ showHistory: e.target.checked })}
          />
          Show history
        </label>
      </section>

      <section>
        <h3>Robot</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showRobot}
            onChange={(e) => onSettingsChange({ showRobot: e.target.checked })}
          />
          Show stick robot
        </label>
        <label>
          Robot scale ({settings.robotScale.toFixed(2)})
          <input
            type="range"
            min={0.2}
            max={2.5}
            step={0.05}
            value={settings.robotScale}
            onChange={(e) => onSettingsChange({ robotScale: Number(e.target.value) })}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showTrail}
            onChange={(e) => onSettingsChange({ showTrail: e.target.checked })}
          />
          Show position trail
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.followRobot}
            onChange={(e) => onSettingsChange({ followRobot: e.target.checked })}
          />
          Follow robot (camera target)
        </label>
        <div className="robot-stats">
          <p>Battery: {robotState?.battery_soc ?? "--"}%</p>
          <p>Power: {robotState?.power_v?.toFixed(1) ?? "--"}V / {robotState?.power_a?.toFixed(1) ?? "--"}A</p>
          <p>Mode: {robotState?.mode ?? "--"} | Gait: {robotState?.gait_type ?? "--"}</p>
        </div>
      </section>

      <section>
        <h3>Scene</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showGrid}
            onChange={(e) => onSettingsChange({ showGrid: e.target.checked })}
          />
          Show grid
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={settings.showAxes}
            onChange={(e) => onSettingsChange({ showAxes: e.target.checked })}
          />
          Show axes
        </label>
      </section>
    </div>
  );
}
