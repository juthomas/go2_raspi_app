# GO2 LiDAR Studio

Standalone web app (Vite + React + TypeScript + Three.js) to visualize:
- live Go2 LiDAR point clouds from the WebSocket bridge,
- temporal cloud persistence (history trail),
- a simple stick robot model using `robot_state` (position, RPY, joints).
- optional live front camera overlay through WebRTC.

## Features

- WebSocket connection to `go2_lidar_ws_bridge.py`
- LiDAR current cloud + history cloud with retention slider
- Point size / point budget / color controls
- Stick robot rendering with pose updates from `robot_state`
- Robot trail and optional camera follow mode
- Scene toggles (grid, axes)
- Optional WebRTC video overlay from `go2_video_webrtc_bridge.py`
- Optional robot control overlay (keyboard arrows + on-screen buttons) via `go2_control_ws_bridge.py`
- UI preference persistence through `localStorage`

## Project structure

- `src/app/App.tsx`: app shell and wiring
- `src/ws/go2BridgeClient.ts`: WebSocket bridge client
- `src/state/useGo2Store.ts`: state and persisted settings
- `src/three/SceneCanvas.tsx`: Three.js mounting and render loop
- `src/three/layers/LidarPointCloudLayer.ts`: current and history point clouds
- `src/three/layers/RobotStickLayer.ts`: stick robot + trajectory
- `src/ui/panels/ControlsPanel.tsx`: menus and controls
- `src/types/go2.ts`: bridge payload types

## Run

1. Install dependencies:

```bash
cd web/go2-lidar-studio
npm install
```

2. Start dev server:

```bash
npm run dev
```

3. Make sure the Go2 bridge runs on the Pi:

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --include-joints
```

4. In the app, set bridge URL (`ws://<ip-du-pi>:8765`) and click Connect.

## Optional camera WebRTC bridge

Install Python deps on the Pi (same venv as the bridge):

```bash
pip install aiohttp aiortc av opencv-python
```

Run the camera bridge:

```bash
python3 scripts/go2_video_webrtc_bridge.py --iface eth0 --port 8081 --fps 15
```

Then in GO2 LiDAR Studio:
- enable `Enable WebRTC video overlay`
- set `WebRTC bridge URL` to `http://<ip-du-pi>:8081`

## Optional robot control bridge (WebSocket)

Run the control bridge:

```bash
python3 scripts/go2_control_ws_bridge.py --iface eth0 --port 8766
```

Then in GO2 LiDAR Studio:
- enable `Enable robot control feature`
- set `Control WS URL` to `ws://<ip-du-pi>:8766`
- use keyboard arrows or on-screen directional buttons

## Data contract expected

Point cloud messages:
- `type: "go2_pointcloud"`
- `points: [[x,y,z], ...]`
- optional `robot_state` block:
  - `position`, `rpy`, `battery_soc`, `power_v`, `power_a`, `joint_q`, etc.

No breaking changes are required on existing LiDAR fields.



```shell
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --include-joints
```

```shell
python3 scripts/go2_video_webrtc_bridge.py --iface eth0 --port 8081 --fps 15
```

```shell
python3 scripts/go2_control_ws_bridge.py --iface eth0 --host 0.0.0.0 --port 8766
```