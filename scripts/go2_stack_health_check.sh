#!/usr/bin/env bash
# Quick health check for GO2 stack (ping, WS ports, optional DDS probe).
set -euo pipefail

APP_ROOT="${GO2_APP_ROOT:-/home/billy/Documents/unitree/go2_raspi_app}"
IFACE="${IFACE:-eth0}"
ROBOT_IP="${ROBOT_IP:-192.168.123.161}"
LIDAR_WS_PORT="${LIDAR_WS_PORT:-8765}"
CONTROL_WS_PORT="${CONTROL_WS_PORT:-8766}"
VIDEO_HTTP_PORT="${VIDEO_HTTP_PORT:-8081}"
PROBE_VOXEL="${PROBE_VOXEL:-0}"

cd "$APP_ROOT"

echo "=== ping $ROBOT_IP ==="
if ping -c 1 -W 2 "$ROBOT_IP"; then
  echo "OK: robot reachable"
else
  echo "FAIL: robot unreachable"
  exit 1
fi

echo ""
echo "=== listening ports ==="
if command -v ss >/dev/null 2>&1; then
  ss -ltnp | rg ":${LIDAR_WS_PORT}|:${CONTROL_WS_PORT}|:${VIDEO_HTTP_PORT}" || {
    echo "WARN: ports $LIDAR_WS_PORT / $CONTROL_WS_PORT / $VIDEO_HTTP_PORT not listening"
  }
else
  echo "WARN: ss not available"
fi

echo ""
echo "=== DDS prepare probe ==="
if [[ -f "$APP_ROOT/.venv/bin/activate" ]]; then
  # shellcheck source=/dev/null
  source "$APP_ROOT/.venv/bin/activate"
  [[ -n "${CYCLONEDDS_HOME:-}" ]] && export CYCLONEDDS_HOME
  PREPARE_ARGS=(--iface "$IFACE" --robot-ip "$ROBOT_IP" --ping-retries 1 --robot-warmup 0)
  if [[ "$PROBE_VOXEL" == "1" ]]; then
    PREPARE_ARGS+=(--probe-voxel)
  fi
  "$APP_ROOT/.venv/bin/python" "$APP_ROOT/scripts/go2_prepare_robot.py" "${PREPARE_ARGS[@]}"
else
  echo "WARN: venv missing, skipping DDS probe"
fi

echo ""
echo "=== done ==="
