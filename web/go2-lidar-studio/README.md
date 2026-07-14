# GO2 LiDAR Studio

Standalone web app (Vite + React + TypeScript + Three.js) to visualize:
- live Go2 LiDAR point clouds from the WebSocket bridge,
- temporal cloud persistence (history trail),
- a simple stick robot model using `robot_state` (position, RPY, joints),
- optional voxel occupancy map from the same WebSocket bridge,
- optional live front camera overlay through WebRTC.

## Features

- WebSocket connection to `go2_lidar_ws_bridge.py`
- LiDAR current cloud + history cloud with retention slider
- Point size / point budget / color controls
- Stick robot rendering with pose updates from `robot_state`
- Optional voxel map layer (`occupied_points` from bridge)
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
- `src/three/layers/VoxelMapLayer.ts`: voxel occupancy points
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

For voxel map visualization, add `--voxel --voxel-decompress` and enable mapping on the robot (Unitree app):

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --voxel --voxel-decompress --include-joints
```

4. In the app, set bridge URL (`ws://<ip-du-pi>:8765`) and click Connect. Enable **Show voxel map** in the Voxel map section when the bridge runs with `--voxel`.

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

Install the Python dependency (same environment as the bridge):

```bash
pip install websockets
```

Run the control bridge:

```bash
python3 scripts/go2_control_ws_bridge.py --iface eth0 --port 8766
```

Then in GO2 LiDAR Studio:
- enable `Enable robot control feature`
- set `Control WS URL` to `ws://<ip-du-pi>:8766`
- use keyboard arrows or on-screen directional buttons

Troubleshooting:
- if `python3 scripts/go2_control_ws_bridge.py ...` exits instantly, check missing module errors (typically `websockets`)
- if the app is opened from another device, avoid `localhost` in `Control WS URL` (use the Pi IP or hostname)
- two WebSocket connections on the same page are fine (`8765` LiDAR + `8766` control)
- if bridge logs show `voxel DDS: 0 (+0 / 5s)` while LiDAR frames increase, enable **3D LiDAR Mapping** in the Unitree app (default topic is `rt/utlidar/voxel_map_compressed`, same namespace as LiDAR)
- if voxel status stays at "metadata only", run the bridge with `--voxel-decompress` and ensure robot mapping is active

## Data contract expected

Point cloud messages:
- `type: "go2_pointcloud"`
- `points: [[x,y,z], ...]`
- optional `robot_state` block:
  - `position`, `rpy`, `battery_soc`, `power_v`, `power_a`, `joint_q`, etc.

Voxel map messages (same WebSocket, separate type):
- `type: "go2_voxel_map"`
- `stamp`, `frame_id`, `resolution`, `origin`, `width`, `data_b64`
- optional `occupied_points: [[x,y,z], ...]` when bridge runs with `--voxel-decompress`
- optional `robot_state` block

Hello message may include `voxel_enabled: true` and `voxel_topic` when `--voxel` is active.

No breaking changes are required on existing LiDAR fields.
