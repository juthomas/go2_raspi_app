#!/usr/bin/env bash
# Stop the GO2 LiDAR WebSocket bridge (go2_lidar_ws_bridge.py).
set -euo pipefail

APP_ROOT="${GO2_APP_ROOT:-/home/billy/Documents/unitree/go2_raspi_app}"
LIDAR_WS_PORT="${LIDAR_WS_PORT:-8765}"
SCRIPT_NAME="go2_lidar_ws_bridge.py"
GRACE_S="${GRACE_S:-5}"

if [[ -f /etc/default/go2-stack ]]; then
  # shellcheck source=/dev/null
  source /etc/default/go2-stack
  LIDAR_WS_PORT="${LIDAR_WS_PORT:-8765}"
fi

collect_pids() {
  local port="$1"
  local pattern="$2"
  local found=""

  if command -v ss >/dev/null 2>&1; then
    found="$(
      ss -ltnp 2>/dev/null \
        | rg ":${port}\s" \
        | sed -n 's/.*pid=\([0-9]*\).*/\1/p' \
        | sort -u
    )"
  fi

  if command -v pgrep >/dev/null 2>&1; then
    found="$(printf '%s\n%s\n' "$found" "$(pgrep -f "$pattern" 2>/dev/null || true)" | rg '^[0-9]+$' | sort -u)"
  fi

  printf '%s\n' "$found" | rg '^[0-9]+$' | sort -u
}

stop_pids() {
  local label="$1"
  shift
  local pids=("$@")
  local pid

  if [[ ${#pids[@]} -eq 0 ]]; then
    echo "[go2_lidar_stop] no ${label} process found (port ${LIDAR_WS_PORT})"
    return 0
  fi

  echo "[go2_lidar_stop] stopping ${label}: pid(s) ${pids[*]}"
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  local deadline=$((SECONDS + GRACE_S))
  while (( SECONDS < deadline )); do
    local alive=()
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        alive+=("$pid")
      fi
    done
    if [[ ${#alive[@]} -eq 0 ]]; then
      echo "[go2_lidar_stop] stopped"
      return 0
    fi
    sleep 0.2
  done

  echo "[go2_lidar_stop] still running, sending SIGKILL..."
  for pid in "${pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  echo "[go2_lidar_stop] stopped (forced)"
}

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet go2-stack 2>/dev/null; then
  echo "[go2_lidar_stop] WARN: go2-stack systemd service is active."
  echo "[go2_lidar_stop]       Killing the LiDAR bridge will stop the whole service and may auto-restart it."
  echo "[go2_lidar_stop]       Prefer: sudo systemctl stop go2-stack"
fi

mapfile -t PIDS < <(collect_pids "$LIDAR_WS_PORT" "$SCRIPT_NAME")
stop_pids "$SCRIPT_NAME" "${PIDS[@]}"

if command -v ss >/dev/null 2>&1; then
  if ss -ltnp 2>/dev/null | rg -q ":${LIDAR_WS_PORT}\s"; then
    echo "[go2_lidar_stop] WARN: port ${LIDAR_WS_PORT} still listening"
    exit 1
  fi
fi

echo "[go2_lidar_stop] port ${LIDAR_WS_PORT} is free"
