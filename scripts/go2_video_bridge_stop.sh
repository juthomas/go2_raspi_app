#!/usr/bin/env bash
# Stop the GO2 video WebRTC bridge (go2_video_webrtc_bridge.py).
set -euo pipefail

APP_ROOT="${GO2_APP_ROOT:-/home/billy/Documents/unitree/go2_raspi_app}"
VIDEO_HTTP_PORT="${VIDEO_HTTP_PORT:-8081}"
SCRIPT_NAME="go2_video_webrtc_bridge.py"
GRACE_S="${GRACE_S:-5}"

if [[ -f /etc/default/go2-stack ]]; then
  # shellcheck source=/dev/null
  source /etc/default/go2-stack
  VIDEO_HTTP_PORT="${VIDEO_HTTP_PORT:-8081}"
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
    echo "[go2_video_stop] no ${label} process found (port ${VIDEO_HTTP_PORT})"
    return 0
  fi

  echo "[go2_video_stop] stopping ${label}: pid(s) ${pids[*]}"
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
      echo "[go2_video_stop] stopped"
      return 0
    fi
    sleep 0.2
  done

  echo "[go2_video_stop] still running, sending SIGKILL..."
  for pid in "${pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  echo "[go2_video_stop] stopped (forced)"
}

mapfile -t PIDS < <(collect_pids "$VIDEO_HTTP_PORT" "$SCRIPT_NAME")
if [[ ${#PIDS[@]} -eq 0 ]]; then
  stop_pids "$SCRIPT_NAME"
  exit 0
fi

stop_pids "$SCRIPT_NAME" "${PIDS[@]}"

if command -v ss >/dev/null 2>&1; then
  if ss -ltnp 2>/dev/null | rg -q ":${VIDEO_HTTP_PORT}\s"; then
    echo "[go2_video_stop] WARN: port ${VIDEO_HTTP_PORT} still listening"
    exit 1
  fi
fi

echo "[go2_video_stop] port ${VIDEO_HTTP_PORT} is free"
