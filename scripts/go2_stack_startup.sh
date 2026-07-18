#!/usr/bin/env bash
# Start GO2 LiDAR + control WebSocket bridges after robot preparation.
set -euo pipefail

APP_ROOT="${GO2_APP_ROOT:-/home/pigeons/Documents/unitree/go2_raspi_app}"
IFACE="${IFACE:-eth0}"
ROBOT_IP="${ROBOT_IP:-192.168.123.161}"
PREPARE_RETRIES="${PREPARE_RETRIES:-30}"
PREPARE_INTERVAL="${PREPARE_INTERVAL:-2}"
ROBOT_WARMUP_S="${ROBOT_WARMUP_S:-5}"
MAPPING_CMDS="${MAPPING_CMDS:-START,ON,start_mapping}"
PREPARE_PROBE_DURATION="${PREPARE_PROBE_DURATION:-5}"
LIDAR_WS_PORT="${LIDAR_WS_PORT:-8765}"
CONTROL_WS_PORT="${CONTROL_WS_PORT:-8766}"
CONTROL_POSTURE_GUARD_S="${CONTROL_POSTURE_GUARD_S:-1.4}"
CONTROL_PRE_POSTURE_DELAY_S="${CONTROL_PRE_POSTURE_DELAY_S:-0.12}"
CONTROL_WS_PING_INTERVAL="${CONTROL_WS_PING_INTERVAL:-0}"
LIDAR_VOXEL="${LIDAR_VOXEL:-1}"
LIDAR_VOXEL_MAP_SOURCE="${LIDAR_VOXEL_MAP_SOURCE:-height_map}"
LIDAR_VOXEL_DECOMPRESS="${LIDAR_VOXEL_DECOMPRESS:-0}"
LIDAR_INCLUDE_JOINTS="${LIDAR_INCLUDE_JOINTS:-1}"
LIDAR_CLOUD_STALL_S="${LIDAR_CLOUD_STALL_S:-8}"
VIDEO_ENABLED="${VIDEO_ENABLED:-1}"
VIDEO_HTTP_PORT="${VIDEO_HTTP_PORT:-8081}"
VIDEO_FPS="${VIDEO_FPS:-15}"

cd "$APP_ROOT"

if [[ -f "$APP_ROOT/.venv/bin/activate" ]]; then
  # shellcheck source=/dev/null
  source "$APP_ROOT/.venv/bin/activate"
else
  echo "[go2_stack] ERROR: venv not found at $APP_ROOT/.venv" >&2
  exit 1
fi

if [[ -n "${CYCLONEDDS_HOME:-}" ]]; then
  export CYCLONEDDS_HOME
fi

PYTHON="$APP_ROOT/.venv/bin/python"
PREPARE="$APP_ROOT/scripts/go2_prepare_robot.py"
CONTROL="$APP_ROOT/scripts/go2_control_ws_bridge.py"
LIDAR="$APP_ROOT/scripts/go2_lidar_ws_bridge.py"
VIDEO="$APP_ROOT/scripts/go2_video_webrtc_bridge.py"

CONTROL_PID=""
VIDEO_PID=""

cleanup() {
  if [[ -n "$VIDEO_PID" ]] && kill -0 "$VIDEO_PID" 2>/dev/null; then
    echo "[go2_stack] stopping video bridge (pid $VIDEO_PID)"
    kill "$VIDEO_PID" 2>/dev/null || true
    wait "$VIDEO_PID" 2>/dev/null || true
  fi
  if [[ -n "$CONTROL_PID" ]] && kill -0 "$CONTROL_PID" 2>/dev/null; then
    echo "[go2_stack] stopping control bridge (pid $CONTROL_PID)"
    kill "$CONTROL_PID" 2>/dev/null || true
    wait "$CONTROL_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[go2_stack] preparing robot on $IFACE (robot $ROBOT_IP)..."
"$PYTHON" "$PREPARE" \
  --iface "$IFACE" \
  --robot-ip "$ROBOT_IP" \
  --ping-retries "$PREPARE_RETRIES" \
  --ping-interval "$PREPARE_INTERVAL" \
  --robot-warmup "$ROBOT_WARMUP_S" \
  --mapping-cmds "$MAPPING_CMDS" \
  --probe-duration "$PREPARE_PROBE_DURATION"

echo "[go2_stack] starting control bridge on port $CONTROL_WS_PORT..."
"$PYTHON" "$CONTROL" \
  --iface "$IFACE" \
  --host 0.0.0.0 \
  --port "$CONTROL_WS_PORT" \
  --posture-guard-s "$CONTROL_POSTURE_GUARD_S" \
  --pre-posture-delay-s "$CONTROL_PRE_POSTURE_DELAY_S" \
  --ws-ping-interval "$CONTROL_WS_PING_INTERVAL" &
CONTROL_PID=$!

sleep 1
if ! kill -0 "$CONTROL_PID" 2>/dev/null; then
  echo "[go2_stack] ERROR: control bridge exited immediately" >&2
  exit 1
fi

if [[ "$VIDEO_ENABLED" == "1" ]]; then
  echo "[go2_stack] starting video WebRTC bridge on port $VIDEO_HTTP_PORT (fps $VIDEO_FPS)..."
  "$PYTHON" "$VIDEO" \
    --iface "$IFACE" \
    --host 0.0.0.0 \
    --port "$VIDEO_HTTP_PORT" \
    --fps "$VIDEO_FPS" &
  VIDEO_PID=$!

  sleep 1
  if ! kill -0 "$VIDEO_PID" 2>/dev/null; then
    echo "[go2_stack] ERROR: video bridge exited immediately" >&2
    exit 1
  fi
else
  echo "[go2_stack] video WebRTC bridge disabled (VIDEO_ENABLED=$VIDEO_ENABLED)"
fi

LIDAR_ARGS=(
  --iface "$IFACE"
  --host 0.0.0.0
  --port "$LIDAR_WS_PORT"
  --cloud-stall-s "$LIDAR_CLOUD_STALL_S"
)
if [[ "$LIDAR_INCLUDE_JOINTS" == "1" ]]; then
  LIDAR_ARGS+=(--include-joints)
fi
if [[ "$LIDAR_VOXEL" == "1" ]]; then
  LIDAR_ARGS+=(--voxel --voxel-map-source "$LIDAR_VOXEL_MAP_SOURCE")
  if [[ "$LIDAR_VOXEL_DECOMPRESS" == "1" ]] && [[ "$LIDAR_VOXEL_MAP_SOURCE" != "height_map" ]]; then
    LIDAR_ARGS+=(--voxel-decompress)
  fi
fi

echo "[go2_stack] starting LiDAR bridge on port $LIDAR_WS_PORT (foreground)..."
exec "$PYTHON" "$LIDAR" "${LIDAR_ARGS[@]}"
