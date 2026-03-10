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

        self._linear_speed = options.linear_speed
        self._yaw_speed = options.yaw_speed
        self._pitch_speed = options.pitch_speed
        self._step_distance_m = options.step_distance_m
        self._step_yaw_deg = options.step_yaw_deg
        self._step_pitch_deg = options.step_pitch_deg
        self._lateral_ratio = options.lateral_ratio

        self._pulse_queue: deque[MotionPulse] = deque(maxlen=32)
        self._active_pulse: MotionPulse | None = None
        self._active_started_at = 0.0
        self._active_until = 0.0

        self._last_tx_ts = 0.0
        self._tx_period = 1.0 / 20.0
        self._is_stopped = True
        self._last_pitch = 0.0
        self._last_cmd = "Stop"

    def run(self) -> int:
        try:
            self._session.connect()
            self._events.append(self._session.ensure_normal_mode())
            curses.wrapper(self._curses_main)
            return 0
        except KeyboardInterrupt:
            return 130
        finally:
            self._panic_stop()
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
            curses.init_pair(1, curses.COLOR_CYAN, -1)
            curses.init_pair(2, curses.COLOR_GREEN, -1)
            curses.init_pair(3, curses.COLOR_YELLOW, -1)
            curses.init_pair(4, curses.COLOR_MAGENTA, -1)
            curses.init_pair(5, curses.COLOR_RED, -1)
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

        # Left joystick: translation pulse.
        if c == "w":
            self._enqueue_linear("FWD", +1.0, 0.0)
            return
        if c == "s":
            self._enqueue_linear("BACK", -1.0, 0.0)
            return
        if c == "a":
            self._enqueue_linear("LEFT", 0.0, +1.0)
            return
        if c == "d":
            self._enqueue_linear("RIGHT", 0.0, -1.0)
            return

        # Right joystick: yaw + pitch pulse.
        if key == curses.KEY_LEFT:
            self._enqueue_yaw("YAW-L", -1.0)
            return
        if key == curses.KEY_RIGHT:
            self._enqueue_yaw("YAW-R", +1.0)
            return
        if key == curses.KEY_UP:
            self._enqueue_pitch("PITCH+", +1.0)
            return
        if key == curses.KEY_DOWN:
            self._enqueue_pitch("PITCH-", -1.0)
            return

        # Emergency / queue control.
        if c in {" ", "x"}:
            self._panic_stop()
            self._events.append("STOP d'urgence + queue vidée.")
            return
        if c == "r":
            self._pulse_queue.clear()
            self._active_pulse = None
            self._events.append("Queue de mouvements vidée.")
            return

        # Speed/step tuning keys.
        if c == "v":
            self._linear_speed = self._bump(self._linear_speed, +0.05, 0.05, 1.20)
            self._events.append(f"linear_speed -> {self._linear_speed:.2f} m/s")
            return
        if c == "b":
            self._linear_speed = self._bump(self._linear_speed, -0.05, 0.05, 1.20)
            self._events.append(f"linear_speed -> {self._linear_speed:.2f} m/s")
            return
        if c == "n":
            self._step_distance_m = self._bump(self._step_distance_m, +0.02, 0.05, 0.60)
            self._events.append(f"step_distance -> {self._step_distance_m:.2f} m")
            return
        if c == "h":
            self._step_distance_m = self._bump(self._step_distance_m, -0.02, 0.05, 0.60)
            self._events.append(f"step_distance -> {self._step_distance_m:.2f} m")
            return
        if c == "o":
            self._yaw_speed = self._bump(self._yaw_speed, +0.10, 0.10, 2.50)
            self._events.append(f"yaw_speed -> {self._yaw_speed:.2f} rad/s")
            return
        if c == "p":
            self._yaw_speed = self._bump(self._yaw_speed, -0.10, 0.10, 2.50)
            self._events.append(f"yaw_speed -> {self._yaw_speed:.2f} rad/s")
            return
        if c == "k":
            self._step_yaw_deg = self._bump(self._step_yaw_deg, +2.0, 2.0, 60.0)
            self._events.append(f"step_yaw -> {self._step_yaw_deg:.1f} deg")
            return
        if c == "j":
            self._step_yaw_deg = self._bump(self._step_yaw_deg, -2.0, 2.0, 60.0)
            self._events.append(f"step_yaw -> {self._step_yaw_deg:.1f} deg")
            return
        if c == "u":
            self._step_pitch_deg = self._bump(self._step_pitch_deg, +1.0, 1.0, 20.0)
            self._events.append(f"step_pitch -> {self._step_pitch_deg:.1f} deg")
            return
        if c == "i":
            self._step_pitch_deg = self._bump(self._step_pitch_deg, -1.0, 1.0, 20.0)
            self._events.append(f"step_pitch -> {self._step_pitch_deg:.1f} deg")
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

    def _enqueue_linear(self, name: str, sign_vx: float, sign_vy: float) -> None:
        vx = sign_vx * self._linear_speed
        vy = sign_vy * self._linear_speed * self._lateral_ratio
        cmd_norm = max(abs(vx), abs(vy), 0.05)
        duration = self._step_distance_m / cmd_norm
        pulse = MotionPulse(name, vx, vy, 0.0, 0.0, duration)
        self._pulse_queue.append(pulse)
        self._events.append(f"+ {name} ({self._step_distance_m:.2f}m)")

    def _enqueue_yaw(self, name: str, sign: float) -> None:
        vyaw = sign * self._yaw_speed
        duration = math.radians(self._step_yaw_deg) / max(abs(vyaw), 0.1)
        pulse = MotionPulse(name, 0.0, 0.0, vyaw, 0.0, duration)
        self._pulse_queue.append(pulse)
        self._events.append(f"+ {name} ({self._step_yaw_deg:.1f}deg)")

    def _enqueue_pitch(self, name: str, sign: float) -> None:
        pitch = sign * math.radians(self._step_pitch_deg)
        duration = abs(pitch) / max(self._pitch_speed, 0.1)
        pulse = MotionPulse(name, 0.0, 0.0, 0.0, pitch, duration)
        self._pulse_queue.append(pulse)
        self._events.append(f"+ {name} ({self._step_pitch_deg:.1f}deg)")

    def _update_motion(self) -> None:
        now = time.monotonic()

        # Start next pulse when previous one is finished.
        if self._active_pulse is None and self._pulse_queue:
            self._active_pulse = self._pulse_queue.popleft()
            self._active_started_at = now
            self._active_until = now + self._active_pulse.duration_s

        if self._active_pulse is not None and now >= self._active_until:
            self._events.append(f"done: {self._active_pulse.name}")
            self._active_pulse = None

        if now - self._last_tx_ts < self._tx_period:
            return

        target_vx = 0.0
        target_vy = 0.0
        target_vyaw = 0.0
        target_pitch = 0.0

        if self._active_pulse is not None:
            target_vx = self._active_pulse.vx
            target_vy = self._active_pulse.vy
            target_vyaw = self._active_pulse.vyaw
            target_pitch = self._active_pulse.pitch

        if target_vx == 0.0 and target_vy == 0.0 and target_vyaw == 0.0:
            if not self._is_stopped:
                code = self._session.stop_move()
                if code != 0:
                    self._events.append(f"StopMove code={code} ({_code_hint(code)})")
                self._is_stopped = True
                self._last_cmd = "Stop"
        else:
            code = self._session.move(target_vx, target_vy, target_vyaw)
            if code != 0:
                self._events.append(f"Move code={code} ({_code_hint(code)})")
            self._is_stopped = False
            self._last_cmd = (
                f"Move vx={target_vx:+.2f} vy={target_vy:+.2f} "
                f"w={target_vyaw:+.2f}"
            )

        if abs(target_pitch - self._last_pitch) >= 0.01:
            euler_code = self._session.euler(0.0, target_pitch, 0.0)
            if euler_code != 0:
                self._events.append(f"Euler code={euler_code} ({_code_hint(euler_code)})")
            self._last_pitch = target_pitch
            self._last_cmd += f" pitch={target_pitch:+.2f}"

        self._last_tx_ts = now

    def _panic_stop(self) -> None:
        self._pulse_queue.clear()
        self._active_pulse = None
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
        header = " GO2 Control Center (DDS Step Teleop) "
        self._safe_add(stdscr, 0, 2, header, pair=1, bold=True)
        self._safe_add(
            stdscr,
            1,
            2,
            f"iface={self._session.iface} | q=quit | queue={len(self._pulse_queue)}",
            pair=3,
        )

        left_w = max_x // 2 - 2
        right_x = left_w + 2
        right_w = max_x - right_x - 1

        robot_win = self._panel(stdscr, 3, 1, 11, left_w, "Robot State", 1)
        teleop_win = self._panel(stdscr, 14, 1, 11, left_w, "Step Teleop", 2)
        keys_win = self._panel(stdscr, 3, right_x, 11, right_w, "Controls", 4)
        modes_win = self._panel(stdscr, 14, right_x, 11, right_w, "Modes / Tuning", 3)
        events_h = max(3, max_y - 25)
        events_win = self._panel(stdscr, 25, 1, events_h, max_x - 2, "Events", 5)

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
        self._panel_add(robot_win, 8, f"foot_force={snap['foot_force']}")

        # Teleop panel
        active_name = self._active_pulse.name if self._active_pulse else "None"
        remaining = 0.0
        progress = 0.0
        if self._active_pulse is not None:
            remaining = max(0.0, self._active_until - time.monotonic())
            elapsed = max(0.0, time.monotonic() - self._active_started_at)
            progress = elapsed / max(self._active_pulse.duration_s, 1e-6)
            progress = _clamp(progress, 0.0, 1.0)
        prog_bar_w = max(10, left_w - 14)
        fill = int(progress * prog_bar_w)
        bar = "[" + "#" * fill + "-" * (prog_bar_w - fill) + "]"

        self._panel_add(teleop_win, 1, f"active={active_name}  remaining={remaining:4.2f}s")
        self._panel_add(teleop_win, 2, f"progress {bar}")
        self._panel_add(
            teleop_win,
            3,
            f"linear_speed={self._linear_speed:.2f} m/s | step={self._step_distance_m:.2f} m",
        )
        self._panel_add(
            teleop_win,
            4,
            f"yaw_speed={self._yaw_speed:.2f} rad/s | yaw_step={self._step_yaw_deg:.1f} deg",
        )
        self._panel_add(
            teleop_win,
            5,
            f"pitch_speed={self._pitch_speed:.2f} rad/s | pitch_step={self._step_pitch_deg:.1f} deg",
        )
        self._panel_add(teleop_win, 6, f"queue_len={len(self._pulse_queue)}")
        self._panel_add(teleop_win, 8, f"last_cmd: {self._last_cmd}")

        # Controls panel
        self._panel_add(keys_win, 1, "W/S: avance/recule (distance fixe)")
        self._panel_add(keys_win, 2, "A/D: gauche/droite (distance fixe)")
        self._panel_add(keys_win, 3, "Fleche gauche/droite: yaw (angle fixe)")
        self._panel_add(keys_win, 4, "Fleche haut/bas: pitch (angle fixe)")
        self._panel_add(keys_win, 6, "x ou Espace: STOP d'urgence")
        self._panel_add(keys_win, 7, "r: vider queue de mouvements")
        self._panel_add(keys_win, 8, "q: quitter")

        # Modes/tuning panel
        self._panel_add(modes_win, 1, "Modes: 1 StandUp  2 StandDown  3 Balance  4 Recovery")
        self._panel_add(modes_win, 2, "       5 Damp     6 Stop      7 Static   8 Trot   9 FreeWalk")
        self._panel_add(modes_win, 3, "m: tenter normal-mode")
        self._panel_add(modes_win, 5, "Tuning vitesse: v/b linear | o/p yaw")
        self._panel_add(modes_win, 6, "Tuning amplitude: n/h distance | k/j yaw step | u/i pitch step")

        # Events panel
        max_lines = events_h - 2
        lines = list(self._events)[-max_lines:]
        for idx, line in enumerate(lines):
            self._panel_add(events_win, 1 + idx, line)

        stdscr.refresh()

    def _render_compact(self, stdscr: Any, snap: dict[str, Any]) -> None:
        self._safe_add(stdscr, 0, 0, "GO2 TUI (compact) - agrandir le terminal pour UI complete.")
        self._safe_add(stdscr, 1, 0, f"iface={self._session.iface} queue={len(self._pulse_queue)}")
        self._safe_add(
            stdscr,
            2,
            0,
            f"battery={snap['battery_soc']}% pos={_fmt_triplet(snap['position'])}",
        )
        self._safe_add(stdscr, 3, 0, f"last_cmd={self._last_cmd}")
        self._safe_add(stdscr, 5, 0, "WASD/Fleches=step move  x=stop  q=quit")
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
