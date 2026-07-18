#!/usr/bin/env bash
# Probe map DDS topics without starting the LiDAR bridge.
set -euo pipefail

APP_ROOT="${GO2_APP_ROOT:-/home/billy/Documents/unitree/go2_raspi_app}"
IFACE="${IFACE:-eth0}"
ROBOT_IP="${ROBOT_IP:-192.168.123.161}"
MAP_SOURCE="${MAP_SOURCE:-height_map}"
HEIGHT_MAP_TOPIC="${HEIGHT_MAP_TOPIC:-rt/utlidar/height_map_array}"
VOXEL_TOPIC="${VOXEL_TOPIC:-rt/utlidar/voxel_map_compressed}"
PROBE_DURATION="${PROBE_DURATION:-15}"
SKIP_MAPPING_CMD="${SKIP_MAPPING_CMD:-0}"

if [[ -f /etc/default/go2-stack ]]; then
  # shellcheck source=/dev/null
  source /etc/default/go2-stack
fi

cd "$APP_ROOT"

if [[ ! -f "$APP_ROOT/.venv/bin/activate" ]]; then
  echo "[go2_voxel_probe] ERROR: venv not found at $APP_ROOT/.venv" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$APP_ROOT/.venv/bin/activate"
[[ -n "${CYCLONEDDS_HOME:-}" ]] && export CYCLONEDDS_HOME

PREPARE_ARGS=(
  --iface "$IFACE"
  --robot-ip "$ROBOT_IP"
  --robot-warmup 2
  --probe-duration 3
  --height-map-probe-duration "$PROBE_DURATION"
  --voxel-probe-duration "$PROBE_DURATION"
  --height-map-topic "$HEIGHT_MAP_TOPIC"
  --voxel-topic "$VOXEL_TOPIC"
)

case "$MAP_SOURCE" in
  height_map)
    PREPARE_ARGS+=(--probe-height-map)
    ;;
  compressed)
    PREPARE_ARGS+=(--probe-voxel)
    ;;
  both)
    PREPARE_ARGS+=(--probe-height-map --probe-voxel)
    ;;
  *)
    echo "[go2_voxel_probe] ERROR: MAP_SOURCE must be height_map, compressed, or both" >&2
    exit 1
    ;;
esac

if [[ "$SKIP_MAPPING_CMD" == "1" ]]; then
  PREPARE_ARGS+=(--skip-mapping-cmd)
fi

echo "[go2_voxel_probe] iface=$IFACE source=$MAP_SOURCE duration=${PROBE_DURATION}s"
echo "[go2_voxel_probe] height_map=$HEIGHT_MAP_TOPIC voxel=$VOXEL_TOPIC"
echo "[go2_voxel_probe] Tip: start mapping recording in Unitree app and move the robot during the probe."
echo "[go2_voxel_probe] Use SKIP_MAPPING_CMD=1 if the app session is already active."

"$APP_ROOT/.venv/bin/python" "$APP_ROOT/scripts/go2_prepare_robot.py" "${PREPARE_ARGS[@]}"
