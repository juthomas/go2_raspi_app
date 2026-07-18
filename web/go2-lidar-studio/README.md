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

For voxel map visualization, add `--voxel` and enable mapping recording in the Unitree app:

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --voxel --include-joints
```

Default map source is **`height_map_array`** (Unitree app mapping). For compressed voxel on EDU firmware:

```bash
python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765 --voxel \
  --voxel-map-source compressed --voxel-decompress --include-joints
```

**Map troubleshooting:** LiDAR OK but no map points → start **recording** in Unitree app (Function → 3D LiDAR Mapping → play), move robot 10–20s. Quick check:

```bash
./scripts/go2_voxel_probe.sh
```

Expected: `height_map probe: N frame(s)` with N > 0.

4. In the app, set bridge URL (`ws://<ip-du-pi>:8765`) and click Connect. Enable **Show voxel map** in the Voxel map section when the bridge runs with `--voxel`.

## Optional camera WebRTC bridge

Install Python deps on the Pi (same venv as the bridge):

```bash
pip install aiohttp aiortc av opencv-python
```

Run the camera bridge:

```bash
python3 scripts/go2_video_webrtc_bridge.py --iface eth0 --port 8081 --fps 15
# stop: ./scripts/go2_video_bridge_stop.sh
```

Check health before debugging the UI:

```bash
curl -s http://<ip-du-pi>:8081/health
# expect: {"ok": true, "frame_age_s": <small number>, "peers": ...}
```

Then in GO2 LiDAR Studio:
- enable `Enable WebRTC video overlay`
- set `WebRTC bridge URL` to `http://<ip-du-pi>:8081` (same host as the page — **not** `127.0.0.1` from another PC)
- status should move `Checking bridge…` → `LIVE` with fps &gt; 0

If LiDAR/control were started manually without the full stack, the video bridge is often missing — start it separately or use `./scripts/go2_stack_startup.sh` (`VIDEO_ENABLED=1`).

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
- use keyboard arrows or on-screen directional buttons (WASD / arrows — **no pilot claim needed to drive**)
- use **ClaimPosturePilot** only for StandUp / StandDown / posture buttons

Troubleshooting:
- if `python3 scripts/go2_control_ws_bridge.py ...` exits instantly, check missing module errors (typically `websockets`)
- if the app is opened from another device, avoid `localhost` in `Control WS URL` (use the Pi IP or hostname)
- two WebSocket connections on the same page are fine (`8765` LiDAR + `8766` control)
- **`send ok` does not mean the robot moved** — watch the overlay line `move: OK` / `move: FAIL code=...` and logs `status op=move_loop` / `robot_error`. Zero `twist` spam in logs is normal when no key is held.
- robot must be **standing** before drive commands work (`ClaimPosturePilot` → `StandUp`, or `go2ctl stand`). Common failure codes: `4202` (sport not ready / robot down), `7004` (motion switcher).
- only one process should listen on `:8766` (`ss -ltnp | rg 8766`). Close the Unitree app / other controllers if move keeps failing.
- multiple browser tabs can drive simultaneously (last-writer-wins on twist); posture commands still require posture pilot.
- WS disconnects with `1011 keepalive ping timeout`: start bridge with `--ws-ping-interval 0` (default in `go2_stack_startup.sh` / `CONTROL_WS_PING_INTERVAL=0`)
- if bridge logs show `map DDS (height_map): 0` while LiDAR frames increase, start mapping **recording** in the Unitree app (not only create a map)
- if using `--voxel-map-source compressed` and status stays at "metadata only", add `--voxel-decompress` and ensure firmware publishes `voxel_map_compressed`

## Data contract expected

Point cloud messages:
- `type: "go2_pointcloud"`
- `points: [[x,y,z], ...]`
- optional `robot_state` block:
  - `position`, `rpy`, `battery_soc`, `power_v`, `power_a`, `joint_q`, etc.

Voxel map messages (same WebSocket, separate type):
- `type: "go2_voxel_map"`
- `stamp`, `frame_id`, `resolution`, `origin`, `width`, `data_b64`
- optional `occupied_points: [[x,y,z], ...]` when bridge runs with `--voxel` (height_map default) or `--voxel-decompress` (compressed source)
- optional `robot_state` block

Hello message may include `voxel_enabled: true`, `voxel_map_source`, and `height_map_topic` / `voxel_topic` when `--voxel` is active.

No breaking changes are required on existing LiDAR fields.
