"""Ncurses TUI for GO2 teleoperation over DDS."""

from __future__ import annotations

import curses
import json
import math
import sys
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any

from go2_cli.config import AppConfig
from go2_cli.errors import CommandExecutionError, UnsupportedTransportError

_CODE_HINTS = {
    0: "OK",
    3102: "Envoi DDS impossible. Verifie le cable ethernet et l'interface reseau.",
    3104: "Timeout RPC. Le robot ne repond pas ou le service n'est pas actif.",
    3203: "API non implementee sur ce firmware.",
    3204: "Parametre API invalide.",
    4202: "Service sport non initialise. Active sport_mode sur le robot.",
    7004: "Service motion_switcher indisponible ou desactive.",
}

_JOINT_COUNT = 12
_POS_STOP_F = 2.146e9
_VEL_STOP_F = 16000.0


def _code_hint(code: int) -> str:
    return _CODE_HINTS.get(code, "Erreur inconnue cote SDK/robot.")


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _fmt_float(value: float | None, width: int = 7, prec: int = 3) -> str:
    if value is None:
        return " " * width
    return f"{value:{width}.{prec}f}"


def _fmt_triplet(values: Any) -> str:
    if values is None:
        return "n/a"
    return f"[{values[0]: .3f}, {values[1]: .3f}, {values[2]: .3f}]"


def _bar(value: float, min_value: float, max_value: float, width: int = 20) -> str:
    span = max(max_value - min_value, 1e-6)
    ratio = _clamp((value - min_value) / span, 0.0, 1.0)
    filled = int(ratio * width)
    return "▕" + "█" * filled + "░" * (width - filled) + "▏"


def _looks_like_normal_mode(payload: Any) -> bool:
    if payload is None:
        return False
    return "normal" in str(payload).lower()


@dataclass
class TuiOptions:
    """Runtime options for step-based teleoperation."""

    linear_speed: float
    yaw_speed: float
    pitch_speed: float
    step_distance_m: float
    step_yaw_deg: float
    step_pitch_deg: float
    profile_start: str | None = None
    control_mode_start: str = "step"
    hold_timeout_s: float = 0.24
    lateral_ratio: float = 0.8
    sequence_file: str = "go2_sequence.json"
    teach_file: str = "go2_teach.json"


@dataclass
class MotionPulse:
    """Single motion pulse command sent during a finite duration."""

    name: str
    vx: float
    vy: float
    vyaw: float
    pitch: float
    duration_s: float


_PROFILE_PRESETS: dict[str, dict[str, float]] = {
    "safe": {
        "linear_speed": 0.20,
        "yaw_speed": 0.55,
        "pitch_speed": 0.45,
        "step_distance_m": 0.10,
        "step_yaw_deg": 8.0,
        "step_pitch_deg": 4.0,
    },
    "indoor": {
        "linear_speed": 0.32,
        "yaw_speed": 0.90,
        "pitch_speed": 0.80,
        "step_distance_m": 0.16,
        "step_yaw_deg": 12.0,
        "step_pitch_deg": 6.0,
    },
    "outdoor": {
        "linear_speed": 0.48,
        "yaw_speed": 1.25,
        "pitch_speed": 1.05,
        "step_distance_m": 0.24,
        "step_yaw_deg": 18.0,
        "step_pitch_deg": 8.0,
    },
}


class DdsTeleopSession:
    """Wraps DDS clients/subscribers used by the TUI."""

    def __init__(self, config: AppConfig):
        self._iface = config.iface
        self._timeout_s = config.timeout_s
        self._ensure_normal_mode_flag = config.ensure_normal_mode
        self._strict_normal_mode_flag = config.strict_normal_mode
        self._connected = False

        self._sport_client: Any = None
        self._motion_switcher_client: Any = None
        self._sport_sub: Any = None
        self._low_sub: Any = None

        self._lock = Lock()
        self._last_sport_state: Any = None
        self._last_low_state: Any = None
        self._last_sport_ts: float | None = None
        self._last_low_ts: float | None = None

        # Low-level teach stream (rt/lowcmd @ high rate).
        self._lowcmd_pub: Any = None
        self._lowcmd_msg: Any = None
        self._lowcmd_crc: Any = None
        self._lowcmd_thread: Any = None
        self._lowcmd_lock = Lock()
        self._teach_stream_enabled = False
        self._teach_target_q: list[float] = [0.0] * _JOINT_COUNT
        self._teach_kp = 38.0
        self._teach_kd = 3.2

    @property
    def iface(self) -> str:
        return self._iface or "n/a"

    def connect(self) -> None:
        if not self._iface:
            raise CommandExecutionError(
                "L'option --iface est requise en transport DDS (ex: eth0)."
            )

        try:
            from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import (
                MotionSwitcherClient,
            )
            from unitree_sdk2py.core.channel import (
                ChannelFactoryInitialize,
                ChannelPublisher,
                ChannelSubscriber,
            )
            from unitree_sdk2py.go2.sport.sport_client import SportClient
            from unitree_sdk2py.idl.default import unitree_go_msg_dds__LowCmd_
            from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowCmd_
            from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_
            from unitree_sdk2py.utils.crc import CRC
            from unitree_sdk2py.utils.thread import RecurrentThread
        except ImportError as exc:
            raise CommandExecutionError(
                "Dependances DDS manquantes/invalides. "
                "Installe cyclonedds puis unitree_sdk2py en editable depuis son repo."
            ) from exc

        try:
            ChannelFactoryInitialize(0, self._iface)

            self._sport_client = SportClient()
            self._sport_client.SetTimeout(self._timeout_s)
            self._sport_client.Init()

            self._motion_switcher_client = MotionSwitcherClient()
            self._motion_switcher_client.SetTimeout(self._timeout_s)
            self._motion_switcher_client.Init()

            self._sport_sub = ChannelSubscriber("rt/sportmodestate", SportModeState_)
            self._sport_sub.Init(self._on_sport_state, 1)
            self._low_sub = ChannelSubscriber("rt/lowstate", LowState_)
            self._low_sub.Init(self._on_low_state, 1)

            self._lowcmd_pub = ChannelPublisher("rt/lowcmd", LowCmd_)
            self._lowcmd_pub.Init()
            self._lowcmd_crc = CRC()
            self._lowcmd_msg = unitree_go_msg_dds__LowCmd_()
            self._init_lowcmd_msg()
            self._lowcmd_thread = RecurrentThread(
                interval=0.005,
                target=self._lowcmd_write_tick,
                name="go2_teach_lowcmd",
            )
            self._lowcmd_thread.Start()
            self._connected = True
        except Exception as exc:
            raise CommandExecutionError(
                f"Initialisation DDS impossible sur interface '{self._iface}'."
            ) from exc

    def close(self) -> None:
        self._connected = False
        self.stop_teach_stream()
        if self._lowcmd_thread is not None:
            try:
                self._lowcmd_thread.Wait(1.0)
            except Exception:
                pass
        self._lowcmd_thread = None
        if self._lowcmd_pub is not None:
            self._lowcmd_pub.Close()
        self._lowcmd_pub = None
        self._lowcmd_msg = None
        self._lowcmd_crc = None
        if self._sport_sub is not None:
            self._sport_sub.Close()
        if self._low_sub is not None:
            self._low_sub.Close()
        self._sport_sub = None
        self._low_sub = None
        self._sport_client = None
        self._motion_switcher_client = None

    def ensure_normal_mode(self) -> str:
        self._require_connected()
        if not self._ensure_normal_mode_flag:
            return "Mode normal auto desactive."

        check_code, payload = self._motion_switcher_client.CheckMode()
        if check_code == 0 and _looks_like_normal_mode(payload):
            return "Mode normal deja actif."

        select_code, _ = self._motion_switcher_client.SelectMode("normal")
        if select_code == 0:
            return "Mode normal active."

        message = (
            "Impossible de forcer le mode normal "
            f"(code={select_code}, hint='{_code_hint(select_code)}')."
        )
        if self._strict_normal_mode_flag:
            raise CommandExecutionError(message)
        return f"WARNING: {message}"

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            sport = self._last_sport_state
            low = self._last_low_state
            sport_ts = self._last_sport_ts
            low_ts = self._last_low_ts

        now = time.monotonic()
        sport_age = None if sport_ts is None else max(0.0, now - sport_ts)
        low_age = None if low_ts is None else max(0.0, now - low_ts)

        return {
            "sport_age": sport_age,
            "low_age": low_age,
            "mode": None if sport is None else int(sport.mode),
            "gait_type": None if sport is None else int(sport.gait_type),
            "progress": None if sport is None else float(sport.progress),
            "error_code": None if sport is None else int(sport.error_code),
            "position": None if sport is None else tuple(float(v) for v in sport.position),
            "velocity": None if sport is None else tuple(float(v) for v in sport.velocity),
            "yaw_speed": None if sport is None else float(sport.yaw_speed),
            "rpy": (
                None
                if sport is None
                else tuple(float(v) for v in sport.imu_state.rpy)
            ),
            "battery_soc": None if low is None else int(low.bms_state.soc),
            "power_v": None if low is None else float(low.power_v),
            "power_a": None if low is None else float(low.power_a),
            "foot_force": None if low is None else tuple(int(v) for v in low.foot_force),
            "joint_q": (
                None
                if low is None
                else tuple(float(low.motor_state[i].q) for i in range(_JOINT_COUNT))
            ),
            "joint_dq": (
                None
                if low is None
                else tuple(float(low.motor_state[i].dq) for i in range(_JOINT_COUNT))
            ),
        }

    def move(self, vx: float, vy: float, vyaw: float) -> int:
        self._require_connected()
        return int(self._sport_client.Move(vx, vy, vyaw))

    def stop_move(self) -> int:
        self._require_connected()
        return int(self._sport_client.StopMove())

    def euler(self, roll: float, pitch: float, yaw: float) -> int:
        self._require_connected()
        return int(self._sport_client.Euler(roll, pitch, yaw))

    def stand_up(self) -> int:
        self._require_connected()
        return int(self._sport_client.StandUp())

    def stand_down(self) -> int:
        self._require_connected()
        return int(self._sport_client.StandDown())

    def recovery_stand(self) -> int:
        self._require_connected()
        return int(self._sport_client.RecoveryStand())

    def balance_stand(self) -> int:
        self._require_connected()
        return int(self._sport_client.BalanceStand())

    def damp(self) -> int:
        self._require_connected()
        return int(self._sport_client.Damp())

    def static_walk(self) -> int:
        self._require_connected()
        return int(self._sport_client.StaticWalk())

    def trot_run(self) -> int:
        self._require_connected()
        return int(self._sport_client.TrotRun())

    def free_walk(self) -> int:
        self._require_connected()
        return int(self._sport_client.FreeWalk())

    def get_joint_positions(self) -> list[float] | None:
        with self._lock:
            low = self._last_low_state
        if low is None:
            return None
        return [float(low.motor_state[i].q) for i in range(_JOINT_COUNT)]

    def prepare_teach_mode(self) -> str:
        self._require_connected()
        events: list[str] = []

        try:
            damp_code = int(self._sport_client.Damp())
            if damp_code != 0:
                events.append(f"Damp code={damp_code}")
        except Exception as exc:
            events.append(f"Damp exception={exc}")

        # Release current sport mode to allow low-level control.
        for _ in range(6):
            try:
                check_code, payload = self._motion_switcher_client.CheckMode()
            except Exception as exc:
                events.append(f"CheckMode exception={exc}")
                break
            if check_code != 0:
                events.append(f"CheckMode code={check_code}")
                break

            mode_name = ""
            if isinstance(payload, dict):
                mode_name = str(payload.get("name", "")).strip()
            elif payload is not None:
                mode_name = str(payload).strip()
            if not mode_name:
                break

            try:
                self._sport_client.StandDown()
            except Exception:
                pass
            release_code, _ = self._motion_switcher_client.ReleaseMode()
            if release_code != 0:
                events.append(f"ReleaseMode code={release_code}")
                break
            time.sleep(0.20)

        self.stop_teach_stream()
        return "Teach mode prepare: OK" if not events else "Teach mode prepare: " + "; ".join(events)

    def start_teach_stream(self, initial_q: list[float], kp: float, kd: float) -> None:
        self._require_connected()
        if self._lowcmd_msg is None or self._lowcmd_pub is None or self._lowcmd_crc is None:
            raise CommandExecutionError("LowCmd non initialise.")
        if len(initial_q) < _JOINT_COUNT:
            raise CommandExecutionError("Trajectoire teach invalide (q<12).")

        with self._lowcmd_lock:
            self._teach_target_q = [
                _clamp(float(v), -3.20, 3.20) for v in initial_q[:_JOINT_COUNT]
            ]
            self._teach_kp = _clamp(float(kp), 5.0, 80.0)
            self._teach_kd = _clamp(float(kd), 0.5, 8.0)
            self._teach_stream_enabled = True

    def set_teach_target(self, q: list[float]) -> None:
        if len(q) < _JOINT_COUNT:
            return
        with self._lowcmd_lock:
            if not self._teach_stream_enabled:
                return
            for i in range(_JOINT_COUNT):
                self._teach_target_q[i] = _clamp(float(q[i]), -3.20, 3.20)

    def stop_teach_stream(self) -> None:
        with self._lowcmd_lock:
            self._teach_stream_enabled = False

    def _init_lowcmd_msg(self) -> None:
        if self._lowcmd_msg is None:
            return
        self._lowcmd_msg.head[0] = 0xFE
        self._lowcmd_msg.head[1] = 0xEF
        self._lowcmd_msg.level_flag = 0xFF
        self._lowcmd_msg.gpio = 0
        for i in range(20):
            mc = self._lowcmd_msg.motor_cmd[i]
            mc.mode = 0x01
            mc.q = _POS_STOP_F
            mc.kp = 0.0
            mc.dq = _VEL_STOP_F
            mc.kd = 0.0
            mc.tau = 0.0

    def _lowcmd_write_tick(self) -> None:
        with self._lowcmd_lock:
            if not self._teach_stream_enabled:
                return
            if self._lowcmd_msg is None or self._lowcmd_pub is None or self._lowcmd_crc is None:
                return

            for i in range(_JOINT_COUNT):
                mc = self._lowcmd_msg.motor_cmd[i]
                mc.mode = 0x01
                mc.q = self._teach_target_q[i]
                mc.kp = self._teach_kp
                mc.dq = 0.0
                mc.kd = self._teach_kd
                mc.tau = 0.0

            for i in range(_JOINT_COUNT, 20):
                mc = self._lowcmd_msg.motor_cmd[i]
                mc.mode = 0x01
                mc.q = _POS_STOP_F
                mc.kp = 0.0
                mc.dq = _VEL_STOP_F
                mc.kd = 0.0
                mc.tau = 0.0

            self._lowcmd_msg.crc = self._lowcmd_crc.Crc(self._lowcmd_msg)
            self._lowcmd_pub.Write(self._lowcmd_msg)

    def _on_sport_state(self, sample: Any) -> None:
        with self._lock:
            self._last_sport_state = sample
            self._last_sport_ts = time.monotonic()

    def _on_low_state(self, sample: Any) -> None:
        with self._lock:
            self._last_low_state = sample
            self._last_low_ts = time.monotonic()

    def _require_connected(self) -> None:
        if not self._connected:
            raise CommandExecutionError("Session DDS non connectee.")


class Go2TuiApp:
    """Ncurses application loop with step-based motion pulses."""

    def __init__(self, session: DdsTeleopSession, options: TuiOptions):
        self._session = session
        self._events: deque[str] = deque(maxlen=40)
        self._running = True
        self._use_colors = False

        self._profile_order = ["safe", "indoor", "outdoor"]
        self._profile_name = "custom"

        self._linear_speed = options.linear_speed
        self._yaw_speed = options.yaw_speed
        self._pitch_speed = options.pitch_speed
        self._step_distance_m = options.step_distance_m
        self._step_yaw_deg = options.step_yaw_deg
        self._step_pitch_deg = options.step_pitch_deg
        self._lateral_ratio = options.lateral_ratio

        if options.profile_start in _PROFILE_PRESETS:
            self._apply_profile(options.profile_start, announce=True)

        self._pulse_queue: deque[MotionPulse] = deque(maxlen=32)
        self._active_pulse: MotionPulse | None = None
        self._active_started_at = 0.0
        self._active_until = 0.0

        # Hold-to-move mode state (keypress repeats refresh timeout).
        self._control_mode = "HOLD" if options.control_mode_start.lower() == "hold" else "STEP"
        self._hold_timeout_s = _clamp(options.hold_timeout_s, 0.08, 1.00)
        self._hold_active_until = 0.0
        self._hold_vx = 0.0
        self._hold_vy = 0.0
        self._hold_vyaw = 0.0
        self._hold_pitch = 0.0
        self._last_hold_name = ""

        self._last_tx_ts = 0.0
        self._tx_period = 1.0 / 20.0
        self._is_stopped = True
        self._last_pitch = 0.0
        self._cmd_vx = 0.0
        self._cmd_vy = 0.0
        self._cmd_vyaw = 0.0
        self._cmd_pitch = 0.0
        self._last_cmd = "Stop"

        # V4: smooth acceleration/deceleration (gamepad-like feel).
        self._cmd_vx = 0.0
        self._cmd_vy = 0.0
        self._cmd_vyaw = 0.0
        self._cmd_pitch = 0.0
        self._linear_accel = 1.10
        self._linear_decel = 1.80
        self._yaw_accel = 2.60
        self._yaw_decel = 3.50
        self._pitch_rise = 1.40
        self._pitch_fall = 1.90
        self._zero_eps = 0.01

        # V5: sequence recorder/player state.
        self._sequence_file = Path(options.sequence_file).expanduser()
        self._sequence_name = "memory"
        self._sequence_initial_mode = self._control_mode
        self._sequence_actions: list[dict[str, Any]] = []

        self._recording = False
        self._record_started_at = 0.0
        self._record_actions: list[dict[str, Any]] = []

        self._playback_running = False
        self._playback_started_at = 0.0
        self._playback_idx = 0

        # V6: real teach mode (manual joint capture + low-level replay).
        self._teach_file = Path(options.teach_file).expanduser()
        self._teach_frames: list[dict[str, Any]] = []
        self._teach_recording = False
        self._teach_record_started_at = 0.0
        self._teach_record_next_sample_at = 0.0
        self._teach_sample_period_s = 0.05  # 20 Hz capture
        self._teach_playing = False
        self._teach_play_started_at = 0.0
        self._teach_play_idx = 0
        self._teach_play_blend_s = 1.2
        self._teach_play_start_q: list[float] = [0.0] * _JOINT_COUNT
        self._teach_kp = 38.0
        self._teach_kd = 3.2

    def run(self) -> int:
        try:
            self._session.connect()
            self._events.append(self._session.ensure_normal_mode())
            curses.wrapper(self._curses_main)
            return 0
        except KeyboardInterrupt:
            return 130
        finally:
            self._shutdown_on_exit()
            self._session.close()

    def _curses_main(self, stdscr: Any) -> None:
        curses.curs_set(0)
        stdscr.nodelay(True)
        stdscr.keypad(True)
        self._init_style()

        while self._running:
            key = stdscr.getch()
            if key != -1:
                self._handle_key(key)

            self._update_motion()
            self._render(stdscr)
            time.sleep(0.02)

    def _init_style(self) -> None:
        try:
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_BLACK, curses.COLOR_CYAN)
            curses.init_pair(2, curses.COLOR_CYAN, -1)
            curses.init_pair(3, curses.COLOR_GREEN, -1)
            curses.init_pair(4, curses.COLOR_YELLOW, -1)
            curses.init_pair(5, curses.COLOR_MAGENTA, -1)
            curses.init_pair(6, curses.COLOR_RED, -1)
            curses.init_pair(7, curses.COLOR_WHITE, -1)
            curses.init_pair(8, curses.COLOR_BLUE, -1)
            self._use_colors = True
        except curses.error:
            self._use_colors = False

    def _handle_key(self, key: int) -> None:
        c_raw = ""
        c = ""
        if 0 <= key <= 255:
            c_raw = chr(key)
            c = c_raw.lower()

        # V5 sequence controls.
        if key == curses.KEY_F5 or c_raw == "R" or c == "f":
            self._toggle_recording()
            return
        if key == curses.KEY_F6 or c_raw == "P" or c == "y":
            self._start_sequence_playback()
            return
        if key == curses.KEY_F7 or c_raw == "K" or c == "g":
            self._save_sequence_to_file()
            return
        if key == curses.KEY_F8 or c_raw == "L" or c == "l":
            self._load_sequence_from_file()
            return

        # V6 teach controls (manual capture + low-level replay).
        if key == curses.KEY_F9 or c_raw == "C" or c == "c":
            self._toggle_teach_recording()
            return
        if key == curses.KEY_F10 or c_raw == "V" or c == "z":
            self._start_teach_playback()
            return
        if key == curses.KEY_F11 or c_raw == "B" or c == "e":
            self._save_teach_to_file()
            return
        if key == curses.KEY_F12 or c_raw == "N" or c == ".":
            self._load_teach_from_file()
            return

        if c == "q":
            self._running = False
            self._events.append("Quit demandé.")
            return

        if c == "t":
            self._control_mode = "HOLD" if self._control_mode == "STEP" else "STEP"
            self._pulse_queue.clear()
            self._active_pulse = None
            self._clear_hold_motion()
            self._events.append(f"control_mode -> {self._control_mode}")
            self._record_action("set_control_mode", mode=self._control_mode)
            return

        # Preset profiles (V3).
        if c == "[":
            self._cycle_profile(-1)
            return
        if c == "]":
            self._cycle_profile(+1)
            return
        if key == curses.KEY_F1:
            self._apply_profile("safe")
            return
        if key == curses.KEY_F2:
            self._apply_profile("indoor")
            return
        if key == curses.KEY_F3:
            self._apply_profile("outdoor")
            return

        # Emergency / queue/hold control.
        if c in {" ", "x"}:
            self._panic_stop()
            self._events.append("STOP d'urgence + queue vidée.")
            self._record_action("mode", token="panic_stop")
            return
        if c == "r":
            if self._control_mode == "STEP":
                self._pulse_queue.clear()
                self._active_pulse = None
                self._events.append("Queue de mouvements vidée.")
            else:
                self._clear_hold_motion()
                self._events.append("Etat HOLD réinitialisé.")
            self._record_action("reset_motion")
            return

        # Speed/step tuning keys.
        if c == "v":
            self._linear_speed = self._bump(self._linear_speed, -0.05, 0.05, 1.20)
            self._mark_profile_custom()
            self._events.append(f"linear_speed -> {self._linear_speed:.2f} m/s")
            return
        if c == "b":
            self._linear_speed = self._bump(self._linear_speed, +0.05, 0.05, 1.20)
            self._mark_profile_custom()
            self._events.append(f"linear_speed -> {self._linear_speed:.2f} m/s")
            return
        if c == "n":
            self._step_distance_m = self._bump(self._step_distance_m, +0.02, 0.05, 0.60)
            self._mark_profile_custom()
            self._events.append(f"step_distance -> {self._step_distance_m:.2f} m")
            return
        if c == "h":
            self._step_distance_m = self._bump(self._step_distance_m, -0.02, 0.05, 0.60)
            self._mark_profile_custom()
            self._events.append(f"step_distance -> {self._step_distance_m:.2f} m")
            return
        if c == "o":
            self._yaw_speed = self._bump(self._yaw_speed, +0.10, 0.10, 2.50)
            self._mark_profile_custom()
            self._events.append(f"yaw_speed -> {self._yaw_speed:.2f} rad/s")
            return
        if c == "p":
            self._yaw_speed = self._bump(self._yaw_speed, -0.10, 0.10, 2.50)
            self._mark_profile_custom()
            self._events.append(f"yaw_speed -> {self._yaw_speed:.2f} rad/s")
            return
        if c == "k":
            self._step_yaw_deg = self._bump(self._step_yaw_deg, +2.0, 2.0, 60.0)
            self._mark_profile_custom()
            self._events.append(f"step_yaw -> {self._step_yaw_deg:.1f} deg")
            return
        if c == "j":
            self._step_yaw_deg = self._bump(self._step_yaw_deg, -2.0, 2.0, 60.0)
            self._mark_profile_custom()
            self._events.append(f"step_yaw -> {self._step_yaw_deg:.1f} deg")
            return
        if c == "u":
            self._step_pitch_deg = self._bump(self._step_pitch_deg, +1.0, 1.0, 20.0)
            self._mark_profile_custom()
            self._events.append(f"step_pitch -> {self._step_pitch_deg:.1f} deg")
            return
        if c == "i":
            self._step_pitch_deg = self._bump(self._step_pitch_deg, -1.0, 1.0, 20.0)
            self._mark_profile_custom()
            self._events.append(f"step_pitch -> {self._step_pitch_deg:.1f} deg")
            return

        # Left joystick: translation.
        if c == "w":
            if self._control_mode == "STEP":
                self._enqueue_linear("FWD", +1.0, 0.0)
            else:
                self._set_hold_motion(
                    "FWD", +self._linear_speed, 0.0, 0.0, 0.0, record=True
                )
            return
        if c == "s":
            if self._control_mode == "STEP":
                self._enqueue_linear("BACK", -1.0, 0.0)
            else:
                self._set_hold_motion(
                    "BACK", -self._linear_speed, 0.0, 0.0, 0.0, record=True
                )
            return
        if c == "a":
            if self._control_mode == "STEP":
                self._enqueue_linear("LEFT", 0.0, +1.0)
            else:
                self._set_hold_motion(
                    "LEFT",
                    0.0,
                    +self._linear_speed * self._lateral_ratio,
                    0.0,
                    0.0,
                    record=True,
                )
            return
        if c == "d":
            if self._control_mode == "STEP":
                self._enqueue_linear("RIGHT", 0.0, -1.0)
            else:
                self._set_hold_motion(
                    "RIGHT",
                    0.0,
                    -self._linear_speed * self._lateral_ratio,
                    0.0,
                    0.0,
                    record=True,
                )
            return

        # Right joystick: yaw + pitch.
        if key == curses.KEY_LEFT:
            if self._control_mode == "STEP":
                # user feedback: yaw left/right were inverted, sign fixed here
                self._enqueue_yaw("YAW-L", +1.0)
            else:
                self._set_hold_motion(
                    "YAW-L", 0.0, 0.0, +self._yaw_speed, 0.0, record=True
                )
            return
        if key == curses.KEY_RIGHT:
            if self._control_mode == "STEP":
                self._enqueue_yaw("YAW-R", -1.0)
            else:
                self._set_hold_motion(
                    "YAW-R", 0.0, 0.0, -self._yaw_speed, 0.0, record=True
                )
            return
        if key == curses.KEY_UP:
            pitch = +math.radians(self._step_pitch_deg)
            if self._control_mode == "STEP":
                self._enqueue_pitch("PITCH+", +1.0)
            else:
                self._set_hold_motion("PITCH+", 0.0, 0.0, 0.0, pitch, record=True)
            return
        if key == curses.KEY_DOWN:
            pitch = -math.radians(self._step_pitch_deg)
            if self._control_mode == "STEP":
                self._enqueue_pitch("PITCH-", -1.0)
            else:
                self._set_hold_motion("PITCH-", 0.0, 0.0, 0.0, pitch, record=True)
            return

        # Standard modes.
        mode_token = {
            "m": "normal_mode",
            "1": "stand_up",
            "2": "stand_down",
            "3": "balance_stand",
            "4": "recovery_stand",
            "5": "damp",
            "6": "stop_move",
            "7": "static_walk",
            "8": "trot_run",
            "9": "free_walk",
        }.get(c)
        if mode_token is not None:
            self._invoke_mode_action(mode_token)
            return

    def _clear_motion_intent(self) -> None:
        self._pulse_queue.clear()
        self._active_pulse = None
        self._clear_hold_motion()
        self._is_stopped = True
        self._last_pitch = 0.0
        self._cmd_vx = 0.0
        self._cmd_vy = 0.0
        self._cmd_vyaw = 0.0
        self._cmd_pitch = 0.0
        self._last_cmd = "Stop"

    def _mode_action_tokens(self) -> set[str]:
        return {
            "normal_mode",
            "stand_up",
            "stand_down",
            "balance_stand",
            "recovery_stand",
            "damp",
            "stop_move",
            "static_walk",
            "trot_run",
            "free_walk",
            "panic_stop",
        }

    def _invoke_mode_action(self, token: str, from_playback: bool = False) -> None:
        if (self._teach_recording or self._teach_playing) and not from_playback:
            self._events.append("Mode refuse: stop Teach REC/PLAY d'abord.")
            return

        if token == "panic_stop":
            self._panic_stop()
            self._events.append("PanicStop: OK")
            if not from_playback:
                self._record_action("mode", token=token)
            return

        action_map: dict[str, tuple[str, Any, bool]] = {
            "normal_mode": ("NormalMode", self._session.ensure_normal_mode, False),
            "stand_up": ("StandUp", self._session.stand_up, True),
            "stand_down": ("StandDown", self._session.stand_down, True),
            "balance_stand": ("BalanceStand", self._session.balance_stand, True),
            "recovery_stand": ("RecoveryStand", self._session.recovery_stand, True),
            "damp": ("Damp", self._session.damp, True),
            "stop_move": ("StopMove", self._session.stop_move, True),
            "static_walk": ("StaticWalk", self._session.static_walk, True),
            "trot_run": ("TrotRun", self._session.trot_run, True),
            "free_walk": ("FreeWalk", self._session.free_walk, True),
        }
        if token not in action_map:
            self._events.append(f"mode inconnu: {token}")
            return

        name, func, expect_code = action_map[token]
        self._call_and_log(name, func, expect_code=expect_code)

        if token == "stop_move":
            self._is_stopped = True
            self._cmd_vx = 0.0
            self._cmd_vy = 0.0
            self._cmd_vyaw = 0.0

        if not from_playback:
            self._record_action("mode", token=token)

    def _record_action(self, action_type: str, **payload: Any) -> None:
        if not self._recording or self._playback_running:
            return
        rel_t = 0.0
        if self._record_started_at > 0.0:
            rel_t = max(0.0, time.monotonic() - self._record_started_at)
        action = {"t": round(rel_t, 3), "type": action_type}
        action.update(payload)
        self._record_actions.append(action)

    def _toggle_recording(self) -> None:
        if self._teach_recording or self._teach_playing:
            self._events.append("REC refuse: mode teach actif.")
            return
        if self._playback_running:
            self._events.append("REC refuse: playback en cours.")
            return

        if not self._recording:
            self._recording = True
            self._record_started_at = time.monotonic()
            self._record_actions = []
            self._sequence_initial_mode = self._control_mode
            self._events.append(f"REC ON (mode={self._control_mode})")
            return

        self._recording = False
        self._record_started_at = 0.0
        self._sequence_actions = [dict(action) for action in self._record_actions]
        self._sequence_name = "memory"
        duration = self._sequence_actions[-1]["t"] if self._sequence_actions else 0.0
        self._events.append(
            f"REC OFF ({len(self._sequence_actions)} actions, {duration:.2f}s)"
        )

    def _start_sequence_playback(self) -> None:
        if self._teach_recording or self._teach_playing:
            self._events.append("PLAY refuse: mode teach actif.")
            return
        if self._recording:
            self._events.append("PLAY refuse: stop REC d'abord.")
            return
        if self._playback_running:
            self._events.append("PLAY deja en cours.")
            return
        if not self._sequence_actions:
            self._events.append(
                f"PLAY impossible: sequence vide (fichier={self._sequence_file.name})."
            )
            return

        self._pulse_queue.clear()
        self._active_pulse = None
        self._clear_hold_motion()

        self._control_mode = self._sequence_initial_mode
        self._playback_running = True
        self._playback_started_at = time.monotonic()
        self._playback_idx = 0
        self._events.append(
            f"PLAY start {self._sequence_name} ({len(self._sequence_actions)} actions)"
        )

    def _save_sequence_to_file(self) -> None:
        if not self._sequence_actions:
            self._events.append("SAVE sequence ignore: rien a sauvegarder.")
            return

        payload = {
            "version": 1,
            "initial_control_mode": self._sequence_initial_mode.lower(),
            "actions": self._sequence_actions,
        }
        try:
            self._sequence_file.parent.mkdir(parents=True, exist_ok=True)
            self._sequence_file.write_text(
                json.dumps(payload, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            self._events.append(f"SEQ saved -> {self._sequence_file}")
        except Exception as exc:
            self._events.append(f"SAVE sequence: exception {exc}")

    def _load_sequence_from_file(self) -> None:
        try:
            payload = json.loads(self._sequence_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self._events.append(f"LOAD sequence: fichier absent ({self._sequence_file})")
            return
        except Exception as exc:
            self._events.append(f"LOAD sequence: exception {exc}")
            return

        try:
            loaded_actions = self._normalize_sequence_actions(payload.get("actions", []))
        except Exception as exc:
            self._events.append(f"LOAD sequence invalide: {exc}")
            return

        loaded_mode = str(payload.get("initial_control_mode", "step")).upper()
        if loaded_mode not in {"STEP", "HOLD"}:
            loaded_mode = "STEP"

        self._sequence_actions = loaded_actions
        self._sequence_initial_mode = loaded_mode
        self._sequence_name = self._sequence_file.name
        duration = loaded_actions[-1]["t"] if loaded_actions else 0.0
        self._events.append(
            f"SEQ loaded: {len(loaded_actions)} actions ({duration:.2f}s, mode={loaded_mode})"
        )

    def _toggle_teach_recording(self) -> None:
        if self._recording or self._playback_running:
            self._events.append("Teach REC refuse: sequence REC/PLAY actif.")
            return
        if self._teach_playing:
            self._events.append("Teach REC refuse: Teach PLAY actif.")
            return

        if not self._teach_recording:
            self._clear_motion_intent()
            prep = self._session.prepare_teach_mode()
            self._teach_frames = []
            self._teach_recording = True
            self._teach_record_started_at = time.monotonic()
            self._teach_record_next_sample_at = 0.0
            self._sample_teach_frame(force=True)
            self._events.append(prep)
            self._events.append("Teach REC ON (manipule le robot a la main).")
            return

        self._teach_recording = False
        self._teach_record_started_at = 0.0
        duration = self._teach_frames[-1]["t"] if self._teach_frames else 0.0
        self._events.append(
            f"Teach REC OFF ({len(self._teach_frames)} frames, {duration:.2f}s)"
        )

    def _sample_teach_frame(self, force: bool = False) -> None:
        if not self._teach_recording:
            return

        now = time.monotonic()
        if (not force) and now < self._teach_record_next_sample_at:
            return

        q = self._session.get_joint_positions()
        if q is None:
            return
        q = [_clamp(float(v), -3.20, 3.20) for v in q[:_JOINT_COUNT]]

        rel_t = max(0.0, now - self._teach_record_started_at)
        frame = {"t": round(rel_t, 3), "q": [round(v, 5) for v in q]}

        if self._teach_frames:
            prev_q = self._teach_frames[-1]["q"]
            max_abs_delta = max(abs(frame["q"][i] - prev_q[i]) for i in range(_JOINT_COUNT))
            if (not force) and max_abs_delta < 0.002:
                self._teach_record_next_sample_at = now + self._teach_sample_period_s
                return

        self._teach_frames.append(frame)
        self._teach_record_next_sample_at = now + self._teach_sample_period_s
        if len(self._teach_frames) > 12000:
            self._teach_recording = False
            self._events.append("Teach REC auto-stop: limite frames atteinte.")

    def _start_teach_playback(self) -> None:
        if self._recording or self._playback_running:
            self._events.append("Teach PLAY refuse: sequence REC/PLAY actif.")
            return
        if self._teach_recording:
            self._events.append("Teach PLAY refuse: stop Teach REC d'abord.")
            return
        if self._teach_playing:
            self._events.append("Teach PLAY deja en cours.")
            return
        if not self._teach_frames:
            self._events.append(
                f"Teach PLAY impossible: teach vide (fichier={self._teach_file.name})."
            )
            return

        self._clear_motion_intent()
        prep = self._session.prepare_teach_mode()
        first_q = self._teach_frames[0]["q"]
        start_q = self._session.get_joint_positions() or list(first_q)
        self._teach_play_start_q = [
            _clamp(float(v), -3.20, 3.20) for v in start_q[:_JOINT_COUNT]
        ]
        try:
            self._session.start_teach_stream(
                initial_q=self._teach_play_start_q,
                kp=self._teach_kp,
                kd=self._teach_kd,
            )
        except Exception as exc:
            self._events.append(f"Teach PLAY init exception: {exc}")
            return

        self._teach_playing = True
        self._teach_play_started_at = time.monotonic()
        self._teach_play_idx = 0
        self._events.append(prep)
        self._events.append(f"Teach PLAY start ({len(self._teach_frames)} frames).")

    def _stop_teach_playback(self, reason: str | None = None) -> None:
        self._teach_playing = False
        self._teach_play_started_at = 0.0
        self._teach_play_idx = 0
        self._session.stop_teach_stream()
        if reason:
            self._events.append(reason)

    def _save_teach_to_file(self) -> None:
        if self._teach_recording:
            self._events.append("Teach SAVE refuse: stop Teach REC d'abord.")
            return
        if not self._teach_frames:
            self._events.append("Teach SAVE ignore: rien a sauvegarder.")
            return

        payload = {
            "version": 1,
            "type": "go2_teach_q12",
            "sample_period_s": self._teach_sample_period_s,
            "kp": self._teach_kp,
            "kd": self._teach_kd,
            "frames": self._teach_frames,
        }
        try:
            self._teach_file.parent.mkdir(parents=True, exist_ok=True)
            self._teach_file.write_text(
                json.dumps(payload, indent=2, sort_keys=True),
                encoding="utf-8",
            )
            self._events.append(f"Teach saved -> {self._teach_file}")
        except Exception as exc:
            self._events.append(f"Teach SAVE exception: {exc}")

    def _load_teach_from_file(self) -> None:
        if self._teach_recording or self._teach_playing:
            self._events.append("Teach LOAD refuse: mode teach actif.")
            return
        try:
            payload = json.loads(self._teach_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self._events.append(f"Teach LOAD: fichier absent ({self._teach_file})")
            return
        except Exception as exc:
            self._events.append(f"Teach LOAD exception: {exc}")
            return

        try:
            frames = self._normalize_teach_frames(payload.get("frames", []))
        except Exception as exc:
            self._events.append(f"Teach LOAD invalide: {exc}")
            return

        self._teach_frames = frames
        self._teach_kp = _clamp(float(payload.get("kp", self._teach_kp)), 5.0, 80.0)
        self._teach_kd = _clamp(float(payload.get("kd", self._teach_kd)), 0.5, 8.0)
        self._events.append(
            f"Teach loaded: {len(frames)} frames ({frames[-1]['t']:.2f}s)"
        )

    def _normalize_teach_frames(self, frames: Any) -> list[dict[str, Any]]:
        if not isinstance(frames, list):
            raise ValueError("frames doit etre une liste.")
        normalized: list[dict[str, Any]] = []
        last_t = 0.0
        for item in frames:
            if not isinstance(item, dict):
                continue
            raw_q = item.get("q")
            if not isinstance(raw_q, (list, tuple)) or len(raw_q) < _JOINT_COUNT:
                continue
            try:
                t = float(item.get("t", last_t))
            except Exception:
                t = last_t
            t = max(last_t, t, 0.0)
            q = [_clamp(float(raw_q[i]), -3.20, 3.20) for i in range(_JOINT_COUNT)]
            normalized.append({"t": round(t, 3), "q": [round(v, 5) for v in q]})
            last_t = t
        if not normalized:
            raise ValueError("aucune frame valide.")
        return normalized

    def _teach_target_at(self, teach_t: float) -> list[float]:
        if len(self._teach_frames) == 1:
            return list(self._teach_frames[0]["q"])

        frames = self._teach_frames
        while (
            self._teach_play_idx + 1 < len(frames)
            and frames[self._teach_play_idx + 1]["t"] <= teach_t
        ):
            self._teach_play_idx += 1

        i0 = self._teach_play_idx
        if i0 >= len(frames) - 1:
            return list(frames[-1]["q"])

        f0 = frames[i0]
        f1 = frames[i0 + 1]
        t0 = float(f0["t"])
        t1 = float(f1["t"])
        if t1 <= t0:
            return list(f1["q"])

        a = _clamp((teach_t - t0) / (t1 - t0), 0.0, 1.0)
        return [
            float(f0["q"][i]) * (1.0 - a) + float(f1["q"][i]) * a
            for i in range(_JOINT_COUNT)
        ]

    def _update_teach(self, now: float) -> None:
        if self._teach_recording:
            self._sample_teach_frame(force=False)
            self._last_cmd = f"TEACH REC ({len(self._teach_frames)} frames)"
            return

        if not self._teach_playing:
            return

        if not self._teach_frames:
            self._stop_teach_playback("Teach PLAY stop: frames vides.")
            return

        elapsed = max(0.0, now - self._teach_play_started_at)
        teach_total = float(self._teach_frames[-1]["t"])

        if elapsed <= self._teach_play_blend_s:
            a = _clamp(elapsed / max(self._teach_play_blend_s, 1e-6), 0.0, 1.0)
            first_q = self._teach_frames[0]["q"]
            target_q = [
                self._teach_play_start_q[i] * (1.0 - a) + float(first_q[i]) * a
                for i in range(_JOINT_COUNT)
            ]
            phase = "blend-in"
        else:
            teach_t = elapsed - self._teach_play_blend_s
            target_q = self._teach_target_at(teach_t)
            phase = f"t={teach_t:.2f}s/{teach_total:.2f}s"

        self._session.set_teach_target(target_q)
        self._last_cmd = f"TEACH PLAY ({phase})"

        if elapsed >= self._teach_play_blend_s + teach_total + 0.20:
            self._stop_teach_playback("Teach PLAY complete.")

    def _normalize_sequence_actions(self, actions: Any) -> list[dict[str, Any]]:
        if not isinstance(actions, list):
            raise ValueError("actions doit etre une liste.")

        mode_tokens = self._mode_action_tokens()
        normalized: list[dict[str, Any]] = []
        last_t = 0.0

        for action in actions:
            if not isinstance(action, dict):
                continue

            try:
                t = float(action.get("t", last_t))
            except Exception:
                t = last_t
            t = max(0.0, t, last_t)

            kind = str(action.get("type", "")).strip()
            fixed: dict[str, Any] | None = None

            if kind == "pulse":
                fixed = {
                    "t": round(t, 3),
                    "type": "pulse",
                    "name": str(action.get("name", "SEQ")),
                    "vx": _clamp(float(action.get("vx", 0.0)), -1.8, 1.8),
                    "vy": _clamp(float(action.get("vy", 0.0)), -1.8, 1.8),
                    "vyaw": _clamp(float(action.get("vyaw", 0.0)), -4.0, 4.0),
                    "pitch": _clamp(float(action.get("pitch", 0.0)), -0.80, 0.80),
                    "duration_s": _clamp(float(action.get("duration_s", 0.1)), 0.02, 5.0),
                }
            elif kind == "hold":
                fixed = {
                    "t": round(t, 3),
                    "type": "hold",
                    "name": str(action.get("name", "SEQ-HOLD")),
                    "vx": _clamp(float(action.get("vx", 0.0)), -1.8, 1.8),
                    "vy": _clamp(float(action.get("vy", 0.0)), -1.8, 1.8),
                    "vyaw": _clamp(float(action.get("vyaw", 0.0)), -4.0, 4.0),
                    "pitch": _clamp(float(action.get("pitch", 0.0)), -0.80, 0.80),
                }
            elif kind == "hold_clear":
                fixed = {"t": round(t, 3), "type": "hold_clear"}
            elif kind == "set_control_mode":
                mode = str(action.get("mode", "STEP")).upper()
                if mode not in {"STEP", "HOLD"}:
                    mode = "STEP"
                fixed = {"t": round(t, 3), "type": "set_control_mode", "mode": mode}
            elif kind == "mode":
                token = str(action.get("token", ""))
                if token in mode_tokens:
                    fixed = {"t": round(t, 3), "type": "mode", "token": token}
            elif kind == "reset_motion":
                fixed = {"t": round(t, 3), "type": "reset_motion"}

            if fixed is not None:
                normalized.append(fixed)
                last_t = fixed["t"]

        return normalized

    def _execute_sequence_action(self, action: dict[str, Any]) -> None:
        kind = str(action.get("type", ""))
        if kind == "pulse":
            pulse = MotionPulse(
                name=str(action.get("name", "SEQ")),
                vx=float(action.get("vx", 0.0)),
                vy=float(action.get("vy", 0.0)),
                vyaw=float(action.get("vyaw", 0.0)),
                pitch=float(action.get("pitch", 0.0)),
                duration_s=float(action.get("duration_s", 0.1)),
            )
            self._queue_or_merge_pulse(pulse, f"SEQ + {pulse.name}")
            return

        if kind == "hold":
            self._set_hold_motion(
                name=str(action.get("name", "SEQ-HOLD")),
                vx=float(action.get("vx", 0.0)),
                vy=float(action.get("vy", 0.0)),
                vyaw=float(action.get("vyaw", 0.0)),
                pitch=float(action.get("pitch", 0.0)),
                record=False,
            )
            return

        if kind == "hold_clear":
            self._clear_hold_motion()
            return

        if kind == "mode":
            self._invoke_mode_action(str(action.get("token", "")), from_playback=True)
            return

        if kind == "set_control_mode":
            mode = str(action.get("mode", "STEP")).upper()
            if mode in {"STEP", "HOLD"}:
                self._control_mode = mode
                self._pulse_queue.clear()
                self._active_pulse = None
                self._clear_hold_motion()
                self._events.append(f"SEQ mode -> {mode}")
            return

        if kind == "reset_motion":
            self._pulse_queue.clear()
            self._active_pulse = None
            self._clear_hold_motion()
            self._events.append("SEQ reset motion")

    def _set_hold_motion(
        self,
        name: str,
        vx: float,
        vy: float,
        vyaw: float,
        pitch: float,
        record: bool = False,
    ) -> None:
        is_new_direction = name != self._last_hold_name
        self._hold_vx = vx
        self._hold_vy = vy
        self._hold_vyaw = vyaw
        self._hold_pitch = pitch
        timeout = self._hold_timeout_s if not is_new_direction else max(
            self._hold_timeout_s, 0.60
        )
        self._hold_active_until = time.monotonic() + timeout
        if is_new_direction:
            self._events.append(f"HOLD {name}")
        self._last_hold_name = name
        if record:
            self._record_action(
                "hold",
                name=name,
                vx=round(vx, 4),
                vy=round(vy, 4),
                vyaw=round(vyaw, 4),
                pitch=round(pitch, 4),
            )

    def _clear_hold_motion(self, record: bool = False) -> None:
        self._hold_vx = 0.0
        self._hold_vy = 0.0
        self._hold_vyaw = 0.0
        self._hold_pitch = 0.0
        self._hold_active_until = 0.0
        self._last_hold_name = ""
        if record:
            self._record_action("hold_clear")

    def _apply_profile(self, name: str, announce: bool = True) -> None:
        preset = _PROFILE_PRESETS[name]
        self._linear_speed = float(preset["linear_speed"])
        self._yaw_speed = float(preset["yaw_speed"])
        self._pitch_speed = float(preset["pitch_speed"])
        self._step_distance_m = float(preset["step_distance_m"])
        self._step_yaw_deg = float(preset["step_yaw_deg"])
        self._step_pitch_deg = float(preset["step_pitch_deg"])
        self._profile_name = name
        if announce:
            self._events.append(
                f"profile -> {name} (lin={self._linear_speed:.2f}, yaw={self._yaw_speed:.2f})"
            )

    def _cycle_profile(self, direction: int) -> None:
        if self._profile_name in self._profile_order:
            idx = self._profile_order.index(self._profile_name)
        else:
            idx = self._profile_order.index("indoor")
        idx = (idx + direction) % len(self._profile_order)
        self._apply_profile(self._profile_order[idx], announce=True)

    def _mark_profile_custom(self) -> None:
        if self._profile_name != "custom":
            self._profile_name = "custom"
            self._events.append("profile -> custom")

    @staticmethod
    def _slew(
        current: float,
        target: float,
        rise_rate: float,
        fall_rate: float,
        dt: float,
    ) -> float:
        if dt <= 0.0:
            return target
        if abs(target - current) <= 1e-9:
            return target
        rate = rise_rate if abs(target) >= abs(current) else fall_rate
        max_delta = max(rate, 0.01) * dt
        delta = target - current
        if abs(delta) <= max_delta:
            return target
        return current + math.copysign(max_delta, delta)

    def _record_pulse_action(self, pulse: MotionPulse) -> None:
        self._record_action(
            "pulse",
            name=pulse.name,
            vx=round(pulse.vx, 4),
            vy=round(pulse.vy, 4),
            vyaw=round(pulse.vyaw, 4),
            pitch=round(pulse.pitch, 4),
            duration_s=round(pulse.duration_s, 4),
        )

    def _enqueue_linear(self, name: str, sign_vx: float, sign_vy: float) -> None:
        vx = sign_vx * self._linear_speed
        vy = sign_vy * self._linear_speed * self._lateral_ratio
        cmd_norm = max(abs(vx), abs(vy), 0.05)
        duration = self._step_distance_m / cmd_norm
        pulse = MotionPulse(name, vx, vy, 0.0, 0.0, duration)
        self._record_pulse_action(pulse)
        self._queue_or_merge_pulse(pulse, f"+ {name} ({self._step_distance_m:.2f}m)")

    def _enqueue_yaw(self, name: str, sign: float) -> None:
        vyaw = sign * self._yaw_speed
        duration = math.radians(self._step_yaw_deg) / max(abs(vyaw), 0.1)
        pulse = MotionPulse(name, 0.0, 0.0, vyaw, 0.0, duration)
        self._record_pulse_action(pulse)
        self._queue_or_merge_pulse(pulse, f"+ {name} ({self._step_yaw_deg:.1f}deg)")

    def _enqueue_pitch(self, name: str, sign: float) -> None:
        pitch = sign * math.radians(self._step_pitch_deg)
        duration = abs(pitch) / max(self._pitch_speed, 0.1)
        pulse = MotionPulse(name, 0.0, 0.0, 0.0, pitch, duration)
        self._record_pulse_action(pulse)
        self._queue_or_merge_pulse(pulse, f"+ {name} ({self._step_pitch_deg:.1f}deg)")

    def _queue_or_merge_pulse(self, pulse: MotionPulse, event_label: str) -> None:
        # V4 anti-overflow: merge consecutive same pulses, otherwise cap queue.
        if self._active_pulse is not None and self._active_pulse.name == pulse.name and not self._pulse_queue:
            self._active_until += pulse.duration_s
            self._events.append(f"~ {pulse.name} extend")
            return

        if self._pulse_queue and self._pulse_queue[-1].name == pulse.name:
            self._pulse_queue[-1].duration_s += pulse.duration_s
            self._events.append(f"~ {pulse.name} merge")
            return

        if len(self._pulse_queue) >= self._pulse_queue.maxlen:
            self._events.append("queue pleine: impulsion ignoree")
            return

        self._pulse_queue.append(pulse)
        self._events.append(event_label)

    def _update_motion(self) -> None:
        now = time.monotonic()

        # Teach mode owns low-level control, so skip high-level move/euler loop.
        if self._teach_recording or self._teach_playing:
            self._update_teach(now)
            self._last_tx_ts = now
            return

        if self._playback_running:
            play_elapsed = max(0.0, now - self._playback_started_at)
            while self._playback_idx < len(self._sequence_actions):
                action = self._sequence_actions[self._playback_idx]
                if float(action.get("t", 0.0)) > play_elapsed:
                    break
                self._execute_sequence_action(action)
                self._playback_idx += 1
            if self._playback_idx >= len(self._sequence_actions):
                self._playback_running = False
                self._events.append("PLAY complete.")

        if self._control_mode == "STEP":
            # Start next pulse when previous one is finished.
            if self._active_pulse is None and self._pulse_queue:
                self._active_pulse = self._pulse_queue.popleft()
                self._active_started_at = now
                self._active_until = now + self._active_pulse.duration_s

            if self._active_pulse is not None and now >= self._active_until:
                self._events.append(f"done: {self._active_pulse.name}")
                self._active_pulse = None

        elapsed = now - self._last_tx_ts if self._last_tx_ts > 0 else self._tx_period
        if elapsed < self._tx_period:
            return

        target_vx = 0.0
        target_vy = 0.0
        target_vyaw = 0.0
        target_pitch = 0.0

        if self._control_mode == "STEP":
            if self._active_pulse is not None:
                target_vx = self._active_pulse.vx
                target_vy = self._active_pulse.vy
                target_vyaw = self._active_pulse.vyaw
                target_pitch = self._active_pulse.pitch
        else:
            if now <= self._hold_active_until:
                target_vx = self._hold_vx
                target_vy = self._hold_vy
                target_vyaw = self._hold_vyaw
                target_pitch = self._hold_pitch
            else:
                self._clear_hold_motion()

        # V4 smooth command shaping.
        self._cmd_vx = self._slew(
            self._cmd_vx, target_vx, self._linear_accel, self._linear_decel, elapsed
        )
        self._cmd_vy = self._slew(
            self._cmd_vy, target_vy, self._linear_accel, self._linear_decel, elapsed
        )
        self._cmd_vyaw = self._slew(
            self._cmd_vyaw, target_vyaw, self._yaw_accel, self._yaw_decel, elapsed
        )
        self._cmd_pitch = self._slew(
            self._cmd_pitch, target_pitch, self._pitch_rise, self._pitch_fall, elapsed
        )

        if (
            abs(self._cmd_vx) < self._zero_eps
            and abs(self._cmd_vy) < self._zero_eps
            and abs(self._cmd_vyaw) < self._zero_eps
            and abs(target_vx) < self._zero_eps
            and abs(target_vy) < self._zero_eps
            and abs(target_vyaw) < self._zero_eps
        ):
            self._cmd_vx = 0.0
            self._cmd_vy = 0.0
            self._cmd_vyaw = 0.0
            if not self._is_stopped:
                code = self._session.stop_move()
                if code != 0:
                    self._events.append(f"StopMove code={code} ({_code_hint(code)})")
                self._is_stopped = True
                self._last_cmd = f"{self._control_mode}: Stop"
        else:
            code = self._session.move(self._cmd_vx, self._cmd_vy, self._cmd_vyaw)
            if code != 0:
                self._events.append(f"Move code={code} ({_code_hint(code)})")
            self._is_stopped = False
            self._last_cmd = (
                f"{self._control_mode}: Move vx={self._cmd_vx:+.2f} "
                f"vy={self._cmd_vy:+.2f} w={self._cmd_vyaw:+.2f}"
            )

        if abs(self._cmd_pitch - self._last_pitch) >= self._zero_eps:
            euler_code = self._session.euler(0.0, self._cmd_pitch, 0.0)
            if euler_code != 0:
                self._events.append(f"Euler code={euler_code} ({_code_hint(euler_code)})")
            self._last_pitch = self._cmd_pitch
            self._last_cmd += f" pitch={self._cmd_pitch:+.2f}"

        self._last_tx_ts = now

    def _panic_stop(self) -> None:
        if self._teach_recording:
            self._teach_recording = False
        if self._teach_playing:
            self._stop_teach_playback()
        self._session.stop_teach_stream()
        self._pulse_queue.clear()
        self._active_pulse = None
        self._clear_hold_motion()
        try:
            self._session.stop_move()
        except Exception:
            pass
        try:
            self._session.euler(0.0, 0.0, 0.0)
        except Exception:
            pass
        self._is_stopped = True
        self._last_pitch = 0.0
        self._cmd_vx = 0.0
        self._cmd_vy = 0.0
        self._cmd_vyaw = 0.0
        self._cmd_pitch = 0.0
        self._last_cmd = "Stop"

    def _shutdown_on_exit(self) -> None:
        # Graceful quit: do not send stop/euler if already idle, which can
        # wake the robot on some firmwares.
        self._teach_recording = False
        if self._teach_playing:
            self._stop_teach_playback()
        self._session.stop_teach_stream()
        self._pulse_queue.clear()
        self._active_pulse = None
        self._clear_hold_motion()

        was_moving = (
            (not self._is_stopped)
            or abs(self._cmd_vx) > self._zero_eps
            or abs(self._cmd_vy) > self._zero_eps
            or abs(self._cmd_vyaw) > self._zero_eps
        )
        if was_moving:
            try:
                self._session.stop_move()
            except Exception:
                pass

        if abs(self._last_pitch) > 0.03 or abs(self._cmd_pitch) > 0.03:
            try:
                self._session.euler(0.0, 0.0, 0.0)
            except Exception:
                pass

        self._is_stopped = True
        self._last_pitch = 0.0
        self._cmd_vx = 0.0
        self._cmd_vy = 0.0
        self._cmd_vyaw = 0.0
        self._cmd_pitch = 0.0
        self._last_cmd = "Stop"

    def _render(self, stdscr: Any) -> None:
        snap = self._session.snapshot()
        stdscr.erase()
        max_y, max_x = stdscr.getmaxyx()

        if max_y < 26 or max_x < 100:
            self._render_compact(stdscr, snap)
            stdscr.refresh()
            return

        # Header
        rec_state = "ON" if self._recording else "off"
        play_state = (
            f"{self._playback_idx}/{len(self._sequence_actions)}"
            if self._playback_running
            else "off"
        )
        teach_rec_state = "ON" if self._teach_recording else "off"
        teach_play_state = (
            f"{self._teach_play_idx}/{len(self._teach_frames)}"
            if self._teach_playing
            else "off"
        )
        self._safe_add(stdscr, 0, 0, " " * (max_x - 1), pair=1)
        header = " GO2 Control Center · DDS "
        self._safe_add(stdscr, 0, 2, header, pair=1, bold=True)
        self._safe_add(
            stdscr,
            1,
            2,
            f"iface={self._session.iface} | mode={self._control_mode} | "
            f"profile={self._profile_name} | queue={len(self._pulse_queue)} | "
            f"rec={rec_state} play={play_state} | "
            f"teach_rec={teach_rec_state} teach_play={teach_play_state} | q=quit",
            pair=4,
        )

        left_w = max_x // 2 - 2
        right_x = left_w + 2
        right_w = max_x - right_x - 1

        robot_win = self._panel(stdscr, 3, 1, 11, left_w, "Robot State ⓘ", 2)
        teleop_win = self._panel(stdscr, 14, 1, 11, left_w, "Teleop ◎", 3)
        keys_win = self._panel(stdscr, 3, right_x, 11, right_w, "Controls ⌨", 5)
        modes_win = self._panel(stdscr, 14, right_x, 11, right_w, "Modes / Tuning ⚙", 4)
        events_h = max(3, max_y - 25)
        events_win = self._panel(stdscr, 25, 1, events_h, max_x - 2, "Events ✦", 6)

        # Robot panel
        self._panel_add(
            robot_win,
            1,
            f"sport_age={_fmt_float(snap['sport_age'], 6, 2)}s   "
            f"low_age={_fmt_float(snap['low_age'], 6, 2)}s",
        )
        self._panel_add(
            robot_win,
            2,
            f"mode={snap['mode']}  gait={snap['gait_type']}  "
            f"progress={_fmt_float(snap['progress'], 5, 2)}",
        )
        self._panel_add(robot_win, 3, f"error_code={snap['error_code']}")
        self._panel_add(robot_win, 4, f"position  {_fmt_triplet(snap['position'])}")
        self._panel_add(robot_win, 5, f"velocity  {_fmt_triplet(snap['velocity'])}")
        self._panel_add(
            robot_win,
            6,
            f"yaw={_fmt_float(snap['yaw_speed'])}   rpy={_fmt_triplet(snap['rpy'])}",
        )
        self._panel_add(
            robot_win,
            7,
            f"battery={snap['battery_soc']}%  V={_fmt_float(snap['power_v'])}  "
            f"A={_fmt_float(snap['power_a'])}",
        )
        if snap["battery_soc"] is None:
            self._panel_add(robot_win, 8, "battery  [no battery data]")
        else:
            self._panel_value_bar(
                robot_win,
                8,
                "battery",
                float(snap["battery_soc"]),
                0.0,
                100.0,
                width=18,
            )
        self._panel_add(robot_win, 9, f"foot_force={snap['foot_force']}")

        # Teleop panel
        active_name = self._active_pulse.name if self._active_pulse else "None"
        remaining = 0.0
        progress = 0.0
        if self._active_pulse is not None:
            remaining = max(0.0, self._active_until - time.monotonic())
            elapsed = max(0.0, time.monotonic() - self._active_started_at)
            progress = elapsed / max(self._active_pulse.duration_s, 1e-6)
            progress = _clamp(progress, 0.0, 1.0)

        self._panel_add(teleop_win, 1, f"active={active_name}  remaining={remaining:4.2f}s")
        self._panel_add(
            teleop_win,
            2,
            f"mode={self._control_mode} hold={self._hold_timeout_s:.2f}s "
            f"rec={rec_state} play={play_state} teach={teach_rec_state}/{teach_play_state}",
        )
        self._panel_ratio_bar(teleop_win, 3, "progress", progress, width=18, pair_hint=8)
        self._panel_value_bar(teleop_win, 4, "linear", self._linear_speed, 0.05, 1.20, width=18)
        self._panel_value_bar(teleop_win, 5, "yaw", self._yaw_speed, 0.10, 2.50, width=18)
        self._panel_value_bar(teleop_win, 6, "pitch", self._pitch_speed, 0.10, 2.50, width=18)
        self._panel_value_bar(
            teleop_win,
            7,
            "queue",
            float(len(self._pulse_queue)),
            0.0,
            float(self._pulse_queue.maxlen),
            width=18,
            pair_hint=5,
        )
        self._panel_add(
            teleop_win,
            8,
            f"lin={self._linear_speed:.2f} step={self._step_distance_m:.2f}m "
            f"yaw={self._yaw_speed:.2f} pitch={self._pitch_speed:.2f}",
        )
        self._panel_add(
            teleop_win,
            9,
            f"seq={len(self._sequence_actions)} teach={len(self._teach_frames)}",
        )

        # Controls panel
        self._panel_add(keys_win, 1, "W/S: avance/recule (step)")
        self._panel_add(keys_win, 2, "A/D: gauche/droite (step)")
        self._panel_add(keys_win, 3, "←/→: yaw  |  ↑/↓: pitch")
        self._panel_add(keys_win, 4, "t: bascule mode STEP ↔ HOLD")
        self._panel_add(keys_win, 5, "R/F: REC on/off   P/Y: PLAY sequence")
        self._panel_add(keys_win, 6, "K/G: SAVE sequence  L: LOAD sequence")
        self._panel_add(keys_win, 7, "c/z: Teach REC/PLAY (manuel + low-level)")
        self._panel_add(keys_win, 8, "e/.: Teach SAVE/LOAD")
        self._panel_add(keys_win, 9, "x/Espace stop | r reset | q quitter")

        # Modes/tuning panel
        self._panel_add(modes_win, 1, "Modes: 1 StandUp  2 StandDown  3 Balance  4 Recovery")
        self._panel_add(modes_win, 2, "       5 Damp     6 Stop      7 Static   8 Trot   9 FreeWalk")
        self._panel_add(modes_win, 3, "m: tenter normal-mode")
        self._panel_add(modes_win, 4, "F1/F2/F3: safe / indoor / outdoor")
        self._panel_add(modes_win, 5, "Tuning vitesse: v=moins / b=plus | o/p yaw")
        self._panel_add(
            modes_win, 6, "Tuning amplitude: n/h dist | k/j yaw_step | u/i pitch_step"
        )
        self._panel_add(modes_win, 7, "V6 Teach: C(rec) V(play) B(save) N(load)")
        self._panel_add(modes_win, 8, f"profile={self._profile_name} last_cmd={self._last_cmd}")
        self._panel_add(
            modes_win,
            9,
            f"seq_file={self._sequence_file.name} teach_file={self._teach_file.name}",
        )

        # Events panel
        max_lines = events_h - 2
        lines = list(self._events)[-max_lines:]
        for idx, line in enumerate(lines):
            self._panel_add(events_win, 1 + idx, line)

        stdscr.refresh()

    def _render_compact(self, stdscr: Any, snap: dict[str, Any]) -> None:
        self._safe_add(stdscr, 0, 0, "GO2 TUI · compact — agrandir le terminal pour UI complete.")
        rec_state = "ON" if self._recording else "off"
        play_state = (
            f"{self._playback_idx}/{len(self._sequence_actions)}"
            if self._playback_running
            else "off"
        )
        teach_rec_state = "ON" if self._teach_recording else "off"
        teach_play_state = (
            f"{self._teach_play_idx}/{len(self._teach_frames)}"
            if self._teach_playing
            else "off"
        )
        self._safe_add(
            stdscr,
            1,
            0,
            f"iface={self._session.iface} mode={self._control_mode} "
            f"profile={self._profile_name} queue={len(self._pulse_queue)} "
            f"rec={rec_state} play={play_state} teach={teach_rec_state}/{teach_play_state}",
        )
        self._safe_add(
            stdscr,
            2,
            0,
            f"battery={snap['battery_soc']}% pos={_fmt_triplet(snap['position'])}",
        )
        self._safe_add(stdscr, 3, 0, f"last_cmd={self._last_cmd}")
        self._safe_add(
            stdscr,
            4,
            0,
            f"seq={len(self._sequence_actions)} teach={len(self._teach_frames)} "
            f"sfile={self._sequence_file.name} tfile={self._teach_file.name}",
        )
        self._safe_add(
            stdscr,
            5,
            0,
            "WASD/←→↑↓ move  t step/hold  R/F/P/Y seq  c/z/e/. teach  x stop  q quit",
        )
        max_y, _ = stdscr.getmaxyx()
        max_lines = max(1, max_y - 7)
        for idx, line in enumerate(list(self._events)[-max_lines:]):
            self._safe_add(stdscr, 6 + idx, 0, line)

    def _call_and_log(self, name: str, func: Any, expect_code: bool = True) -> None:
        try:
            result = func()
            if expect_code:
                code = int(result)
                if code == 0:
                    self._events.append(f"{name}: OK")
                else:
                    self._events.append(f"{name}: code={code} ({_code_hint(code)})")
            else:
                self._events.append(str(result))
        except CommandExecutionError as exc:
            self._events.append(f"{name}: {exc}")
        except Exception as exc:
            self._events.append(f"{name}: exception {exc}")

    def _panel(
        self, stdscr: Any, y: int, x: int, h: int, w: int, title: str, pair: int
    ) -> Any:
        win = stdscr.derwin(h, w, y, x)
        win.erase()
        if self._use_colors and pair > 0:
            win.attron(curses.color_pair(pair))
        win.box()
        if self._use_colors and pair > 0:
            win.attroff(curses.color_pair(pair))
        self._panel_add(win, 0, f" {title} ", x=2, bold=True, pair=pair)
        return win

    def _panel_put(
        self,
        win: Any,
        y: int,
        x: int,
        text: str,
        pair: int = 0,
        bold: bool = False,
    ) -> None:
        max_y, max_x = win.getmaxyx()
        if y < 0 or y >= max_y:
            return
        if x < 0 or x >= max_x:
            return
        clipped = text[: max_x - x - 1]
        attr = 0
        if bold:
            attr |= curses.A_BOLD
        if self._use_colors and pair > 0:
            attr |= curses.color_pair(pair)
        try:
            win.addstr(y, x, clipped, attr)
        except curses.error:
            return

    def _bar_fill_pair(self, ratio: float) -> int:
        if ratio < 0.55:
            return 3  # green
        if ratio < 0.80:
            return 4  # yellow
        return 6  # red

    def _panel_value_bar(
        self,
        win: Any,
        y: int,
        label: str,
        value: float,
        min_value: float,
        max_value: float,
        width: int = 18,
        pair_hint: int | None = None,
    ) -> None:
        label_w = 9
        x0 = 1
        span = max(max_value - min_value, 1e-6)
        ratio = _clamp((value - min_value) / span, 0.0, 1.0)
        filled = int(ratio * width)
        fill_pair = pair_hint if pair_hint is not None else self._bar_fill_pair(ratio)

        self._panel_put(win, y, x0, f"{label:<{label_w}}", pair=7)
        self._panel_put(win, y, x0 + label_w, "▕", pair=7)
        for idx in range(width):
            ch = "█" if idx < filled else "░"
            pair = fill_pair if idx < filled else 7
            self._panel_put(win, y, x0 + label_w + 1 + idx, ch, pair=pair)
        self._panel_put(win, y, x0 + label_w + 1 + width, "▏", pair=7)
        self._panel_put(win, y, x0 + label_w + 1 + width + 2, f"{value:>5.2f}", pair=7)

    def _panel_ratio_bar(
        self,
        win: Any,
        y: int,
        label: str,
        ratio: float,
        width: int = 18,
        pair_hint: int | None = None,
    ) -> None:
        self._panel_value_bar(
            win=win,
            y=y,
            label=label,
            value=ratio,
            min_value=0.0,
            max_value=1.0,
            width=width,
            pair_hint=pair_hint,
        )

    def _panel_add(
        self,
        win: Any,
        y: int,
        text: str,
        x: int = 1,
        bold: bool = False,
        pair: int = 0,
    ) -> None:
        max_y, max_x = win.getmaxyx()
        if y < 0 or y >= max_y - 0:
            return
        if x < 0 or x >= max_x:
            return
        clipped = text[: max_x - x - 1]
        attr = 0
        if bold:
            attr |= curses.A_BOLD
        if self._use_colors and pair > 0:
            attr |= curses.color_pair(pair)
        try:
            win.addstr(y, x, clipped, attr)
        except curses.error:
            return

    def _safe_add(
        self,
        stdscr: Any,
        y: int,
        x: int,
        text: str,
        pair: int = 0,
        bold: bool = False,
    ) -> None:
        max_y, max_x = stdscr.getmaxyx()
        if y < 0 or y >= max_y:
            return
        if x < 0 or x >= max_x:
            return
        clipped = text[: max_x - x - 1]
        attr = 0
        if bold:
            attr |= curses.A_BOLD
        if self._use_colors and pair > 0:
            attr |= curses.color_pair(pair)
        try:
            stdscr.addstr(y, x, clipped, attr)
        except curses.error:
            return

    @staticmethod
    def _bump(current: float, delta: float, lo: float, hi: float) -> float:
        return _clamp(round(current + delta, 4), lo, hi)


def run_tui(config: AppConfig, options: TuiOptions) -> int:
    """Run ncurses teleop mode."""
    if config.transport != "dds":
        raise UnsupportedTransportError(
            "Le mode TUI est disponible uniquement pour --transport dds."
        )

    if sys.platform == "win32":
        raise UnsupportedTransportError("Ncurses n'est pas supporte sous Windows.")

    app = Go2TuiApp(DdsTeleopSession(config), options)
    return app.run()
