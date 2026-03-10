"""Ncurses TUI for GO2 teleoperation over DDS."""

from __future__ import annotations

import curses
import math
import sys
import time
from collections import deque
from dataclasses import dataclass
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
            from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
            from unitree_sdk2py.go2.sport.sport_client import SportClient
            from unitree_sdk2py.idl.unitree_go.msg.dds_ import LowState_, SportModeState_
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
            self._connected = True
        except Exception as exc:
            raise CommandExecutionError(
                f"Initialisation DDS impossible sur interface '{self._iface}'."
            ) from exc

    def close(self) -> None:
        self._connected = False
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
        c = ""
        if 0 <= key <= 255:
            c = chr(key).lower()

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
            return
        if c == "r":
            if self._control_mode == "STEP":
                self._pulse_queue.clear()
                self._active_pulse = None
                self._events.append("Queue de mouvements vidée.")
            else:
                self._clear_hold_motion()
                self._events.append("Etat HOLD réinitialisé.")
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
                self._set_hold_motion("FWD", +self._linear_speed, 0.0, 0.0, 0.0)
            return
        if c == "s":
            if self._control_mode == "STEP":
                self._enqueue_linear("BACK", -1.0, 0.0)
            else:
                self._set_hold_motion("BACK", -self._linear_speed, 0.0, 0.0, 0.0)
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
                )
            return

        # Right joystick: yaw + pitch.
        if key == curses.KEY_LEFT:
            if self._control_mode == "STEP":
                # user feedback: yaw left/right were inverted, sign fixed here
                self._enqueue_yaw("YAW-L", +1.0)
            else:
                self._set_hold_motion("YAW-L", 0.0, 0.0, +self._yaw_speed, 0.0)
            return
        if key == curses.KEY_RIGHT:
            if self._control_mode == "STEP":
                self._enqueue_yaw("YAW-R", -1.0)
            else:
                self._set_hold_motion("YAW-R", 0.0, 0.0, -self._yaw_speed, 0.0)
            return
        if key == curses.KEY_UP:
            pitch = +math.radians(self._step_pitch_deg)
            if self._control_mode == "STEP":
                self._enqueue_pitch("PITCH+", +1.0)
            else:
                self._set_hold_motion("PITCH+", 0.0, 0.0, 0.0, pitch)
            return
        if key == curses.KEY_DOWN:
            pitch = -math.radians(self._step_pitch_deg)
            if self._control_mode == "STEP":
                self._enqueue_pitch("PITCH-", -1.0)
            else:
                self._set_hold_motion("PITCH-", 0.0, 0.0, 0.0, pitch)
            return

        # Standard modes.
        if c == "m":
            self._call_and_log("NormalMode", self._session.ensure_normal_mode, expect_code=False)
        elif c == "1":
            self._call_and_log("StandUp", self._session.stand_up)
        elif c == "2":
            self._call_and_log("StandDown", self._session.stand_down)
        elif c == "3":
            self._call_and_log("BalanceStand", self._session.balance_stand)
        elif c == "4":
            self._call_and_log("RecoveryStand", self._session.recovery_stand)
        elif c == "5":
            self._call_and_log("Damp", self._session.damp)
        elif c == "6":
            self._call_and_log("StopMove", self._session.stop_move)
        elif c == "7":
            self._call_and_log("StaticWalk", self._session.static_walk)
        elif c == "8":
            self._call_and_log("TrotRun", self._session.trot_run)
        elif c == "9":
            self._call_and_log("FreeWalk", self._session.free_walk)

    def _set_hold_motion(
        self, name: str, vx: float, vy: float, vyaw: float, pitch: float
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

    def _clear_hold_motion(self) -> None:
        self._hold_vx = 0.0
        self._hold_vy = 0.0
        self._hold_vyaw = 0.0
        self._hold_pitch = 0.0
        self._hold_active_until = 0.0
        self._last_hold_name = ""

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

    def _enqueue_linear(self, name: str, sign_vx: float, sign_vy: float) -> None:
        vx = sign_vx * self._linear_speed
        vy = sign_vy * self._linear_speed * self._lateral_ratio
        cmd_norm = max(abs(vx), abs(vy), 0.05)
        duration = self._step_distance_m / cmd_norm
        pulse = MotionPulse(name, vx, vy, 0.0, 0.0, duration)
        self._queue_or_merge_pulse(pulse, f"+ {name} ({self._step_distance_m:.2f}m)")

    def _enqueue_yaw(self, name: str, sign: float) -> None:
        vyaw = sign * self._yaw_speed
        duration = math.radians(self._step_yaw_deg) / max(abs(vyaw), 0.1)
        pulse = MotionPulse(name, 0.0, 0.0, vyaw, 0.0, duration)
        self._queue_or_merge_pulse(pulse, f"+ {name} ({self._step_yaw_deg:.1f}deg)")

    def _enqueue_pitch(self, name: str, sign: float) -> None:
        pitch = sign * math.radians(self._step_pitch_deg)
        duration = abs(pitch) / max(self._pitch_speed, 0.1)
        pulse = MotionPulse(name, 0.0, 0.0, 0.0, pitch, duration)
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
        self._safe_add(stdscr, 0, 0, " " * (max_x - 1), pair=1)
        header = " GO2 Control Center · DDS "
        self._safe_add(stdscr, 0, 2, header, pair=1, bold=True)
        self._safe_add(
            stdscr,
            1,
            2,
            f"iface={self._session.iface} | mode={self._control_mode} | "
            f"profile={self._profile_name} | queue={len(self._pulse_queue)} | q=quit",
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
            f"mode={self._control_mode}  hold_timeout={self._hold_timeout_s:.2f}s",
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
            f"lin={self._linear_speed:.2f}m/s step={self._step_distance_m:.2f}m "
            f"| yaw={self._yaw_speed:.2f} rad/s",
        )
        self._panel_add(
            teleop_win,
            9,
            f"yaw_step={self._step_yaw_deg:.1f}deg pitch_step={self._step_pitch_deg:.1f}deg",
        )

        # Controls panel
        self._panel_add(keys_win, 1, "W/S: avance/recule (step)")
        self._panel_add(keys_win, 2, "A/D: gauche/droite (step)")
        self._panel_add(keys_win, 3, "←/→: yaw  |  ↑/↓: pitch")
        self._panel_add(keys_win, 4, "t: bascule mode STEP ↔ HOLD")
        self._panel_add(keys_win, 5, "[: profil prec.   ]: profil suiv.")
        self._panel_add(keys_win, 6, "x/Espace: STOP d'urgence")
        self._panel_add(keys_win, 7, "r: reset queue/hold")
        self._panel_add(keys_win, 8, "q: quitter")

        # Modes/tuning panel
        self._panel_add(modes_win, 1, "Modes: 1 StandUp  2 StandDown  3 Balance  4 Recovery")
        self._panel_add(modes_win, 2, "       5 Damp     6 Stop      7 Static   8 Trot   9 FreeWalk")
        self._panel_add(modes_win, 3, "m: tenter normal-mode")
        self._panel_add(modes_win, 4, "F1/F2/F3: safe / indoor / outdoor")
        self._panel_add(modes_win, 5, "Tuning vitesse: v=moins / b=plus | o/p yaw")
        self._panel_add(modes_win, 6, "Tuning amplitude: n/h dist | k/j yaw_step | u/i pitch_step")
        self._panel_add(modes_win, 7, "V4: ramp accel/decel + anti-overflow queue")
        self._panel_add(modes_win, 8, f"profile={self._profile_name}  last_cmd: {self._last_cmd}")

        # Events panel
        max_lines = events_h - 2
        lines = list(self._events)[-max_lines:]
        for idx, line in enumerate(lines):
            self._panel_add(events_win, 1 + idx, line)

        stdscr.refresh()

    def _render_compact(self, stdscr: Any, snap: dict[str, Any]) -> None:
        self._safe_add(stdscr, 0, 0, "GO2 TUI · compact — agrandir le terminal pour UI complete.")
        self._safe_add(
            stdscr,
            1,
            0,
            f"iface={self._session.iface} mode={self._control_mode} "
            f"profile={self._profile_name} queue={len(self._pulse_queue)}",
        )
        self._safe_add(
            stdscr,
            2,
            0,
            f"battery={snap['battery_soc']}% pos={_fmt_triplet(snap['position'])}",
        )
        self._safe_add(stdscr, 3, 0, f"last_cmd={self._last_cmd}")
        self._safe_add(stdscr, 5, 0, "WASD/←→↑↓ move  t=step/hold  [/] profile  x=stop  q=quit")
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
