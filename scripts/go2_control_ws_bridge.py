#!/usr/bin/env python3
"""
Simple GO2 control bridge (DDS sport RPC <-> WebSocket JSON).

WebSocket protocol:
  - server -> client:
      {"type":"hello","iface":"eth0","multi_control":true}
      {"type":"ack","cmd":"stand_up","ok":true}
      {"type":"status","pilot":true,"posture_pilot":true,"vx":0.2,...}
      {"type":"robot_error","op":"move_loop","code":4202,"hint":"..."}
      {"type":"log","level":"info","msg":"pilot granted","ts":1710000000.12}
      {"type":"error","msg":"..."}
  - client -> server:
      {"type":"claim_pilot"}
      {"type":"release_pilot"}
      {"type":"stand_up"}
      {"type":"stand_down"}
      {"type":"normal_mode"}
      {"type":"balance_stand"}
      {"type":"recovery_stand"}
      {"type":"stop"}
      {"type":"twist","vx":0.2,"vy":0.0,"vyaw":0.0}
      {"type":"shutdown_pi"}
      {"type":"front_led","enable":1}
      {"type":"front_led_on"}
      {"type":"front_led_off"}
      {"type":"front_led_brightness","level":5}
      {"type":"front_led_color","color":"red"}
        # front_led_color: omit time or time<=0 = hold long; time>0 = temporary seconds
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from typing import Any


VUI_API_ID_SETCOLOR = 1007
VUI_COLORS = frozenset({"white", "red", "yellow", "blue", "green", "cyan", "purple"})
# API 1007 `time` is duration in seconds before reverting to system green.
# time<=0 from clients means "hold"; we send a long duration and refresh it.
VUI_COLOR_HOLD_S = 3600
VUI_COLOR_REFRESH_S = 300.0

_CODE_HINTS = {
    -1: "SDK/robot service rejected command (often stale sport state or mode mismatch).",
    0: "OK",
    3102: "DDS send failed (check iface/cable).",
    3104: "RPC timeout.",
    3203: "API unsupported by firmware.",
    3204: "Invalid argument.",
    4202: "sport service not initialized.",
    4205: "sport service busy/stale (rearm often needed).",
    7004: "motion_switcher service unavailable/disabled.",
}


def _code_hint(code: int) -> str:
    return _CODE_HINTS.get(code, "Unknown SDK/robot error.")


def _looks_like_normal_mode(payload: Any) -> bool:
    return payload is not None and "normal" in str(payload).lower()


def _safe_float(raw: Any, *, default: float = 0.0) -> float:
    try:
        value = float(raw)
    except Exception:
        return default
    if not math.isfinite(value):
        return default
    return value


def _client_label(ws: Any) -> str:
    return str(getattr(ws, "remote_address", "?"))


async def _amain(args: argparse.Namespace) -> None:
    try:
        import websockets
        from websockets.exceptions import ConnectionClosed
        from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import MotionSwitcherClient
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize
        from unitree_sdk2py.go2.sport.sport_client import SportClient
        from unitree_sdk2py.go2.vui.vui_client import VuiClient
    except ImportError as e:
        raise SystemExit(
            "Missing dependency: "
            f"{e}. Install in the project venv (recommended): "
            "'.venv/bin/python -m pip install websockets' "
            "and run this script with '.venv/bin/python ...'."
        ) from e

    ChannelFactoryInitialize(0, args.iface)
    sport = SportClient()
    sport.SetTimeout(args.timeout_s)
    sport.Init()
    motion = MotionSwitcherClient()
    motion.SetTimeout(args.timeout_s)
    motion.Init()
    vui = VuiClient()
    vui.SetTimeout(args.timeout_s)
    vui.Init()
    # Undocumented in official Python VuiClient; used by Unitree app / WebRTC (api 1007).
    vui._RegistApi(VUI_API_ID_SETCOLOR, 0)

    clients: set[Any] = set()
    clients_lock = asyncio.Lock()
    pilot: dict[str, Any] = {"ws": None}
    pilot_lock = asyncio.Lock()

    # Per-client twist targets (last-writer-wins across clients).
    targets: dict[int, dict[str, Any]] = {}
    targets_lock = asyncio.Lock()
    active_meta = {"controller": None, "vx": 0.0, "vy": 0.0, "vyaw": 0.0}
    active_meta_lock = asyncio.Lock()

    runtime = {"last_code": 0, "last_op": "init", "last_error": "", "last_move_ts": 0.0}
    runtime_lock = asyncio.Lock()
    sdk_lock = asyncio.Lock()
    posture_op_lock = asyncio.Lock()
    vui_lock = asyncio.Lock()
    # Last LED intent to refresh (firmware restores green status otherwise).
    led_hold: dict[str, Any] = {"mode": None, "color": None}  # mode: None | "color" | "off"
    led_hold_lock = asyncio.Lock()
    control_gate = {"until_ts": 0.0}
    control_gate_lock = asyncio.Lock()

    async def set_client_target(ws: Any, vx: float, vy: float, vyaw: float) -> None:
        key = id(ws)
        async with targets_lock:
            targets[key] = {
                "vx": float(vx),
                "vy": float(vy),
                "vyaw": float(vyaw),
                "ts": time.monotonic(),
                "label": _client_label(ws),
            }

    async def clear_client_target(ws: Any) -> None:
        key = id(ws)
        async with targets_lock:
            targets.pop(key, None)

    async def clear_all_targets() -> None:
        async with targets_lock:
            targets.clear()

    async def resolve_active_target() -> tuple[float, float, float, str | None]:
        now = time.monotonic()
        best: dict[str, Any] | None = None
        async with targets_lock:
            for entry in targets.values():
                if now - float(entry["ts"]) > args.command_timeout:
                    continue
                if best is None or float(entry["ts"]) > float(best["ts"]):
                    best = entry
        if best is None:
            return 0.0, 0.0, 0.0, None
        return float(best["vx"]), float(best["vy"]), float(best["vyaw"]), str(best["label"])

    async def _send_json(ws: Any, payload: dict[str, Any]) -> None:
        try:
            await asyncio.wait_for(ws.send(json.dumps(payload)), timeout=1.0)
        except Exception:
            pass

    async def _ack(ws: Any, cmd: str, ok: bool, msg: str | None = None) -> None:
        payload: dict[str, Any] = {"type": "ack", "cmd": cmd, "ok": bool(ok)}
        if msg:
            payload["msg"] = msg
        await _send_json(ws, payload)

    async def _broadcast_payload(payload: dict[str, Any]) -> None:
        text = json.dumps(payload)
        async with clients_lock:
            snapshot = list(clients)
        dead: list[Any] = []
        for c in snapshot:
            try:
                await asyncio.wait_for(c.send(text), timeout=1.0)
            except Exception:
                dead.append(c)
        if dead:
            async with clients_lock:
                for c in dead:
                    clients.discard(c)

    async def _build_status_payload(*, for_ws: Any | None = None) -> dict[str, Any]:
        vx, vy, vyaw, controller = await resolve_active_target()
        async with active_meta_lock:
            active_meta["controller"] = controller
            active_meta["vx"] = vx
            active_meta["vy"] = vy
            active_meta["vyaw"] = vyaw
        async with pilot_lock:
            pilot_ws = pilot["ws"]
            has_posture_pilot = pilot_ws is not None
            you_are_posture_pilot = for_ws is not None and pilot_ws is for_ws
        async with clients_lock:
            n_clients = len(clients)
        async with runtime_lock:
            last_code = int(runtime["last_code"])
            last_op = str(runtime["last_op"])
            last_error = str(runtime["last_error"])

        move_ok = last_code == 0
        move_hint = _code_hint(last_code) if last_code != 0 else "OK"
        return {
            "type": "status",
            "pilot": has_posture_pilot,
            "posture_pilot": has_posture_pilot,
            # Per-client: True only for the websocket that claimed posture pilot.
            "you_are_posture_pilot": you_are_posture_pilot,
            "multi_control": bool(args.multi_control),
            "connected_clients": n_clients,
            "can_drive": n_clients > 0 and (args.multi_control or has_posture_pilot),
            "active_controller": controller,
            "vx": vx,
            "vy": vy,
            "vyaw": vyaw,
            "last_code": last_code,
            "last_op": last_op,
            "last_error": last_error,
            "move_ok": move_ok,
            "move_hint": move_hint,
        }

    async def _broadcast_status() -> None:
        async with clients_lock:
            snapshot = list(clients)
        dead: list[Any] = []
        for c in snapshot:
            try:
                await _send_json(c, await _build_status_payload(for_ws=c))
            except Exception:
                dead.append(c)
        if dead:
            async with clients_lock:
                for c in dead:
                    clients.discard(c)

    async def _broadcast_log(msg: str, *, level: str = "info") -> None:
        payload = {"type": "log", "level": str(level), "msg": str(msg), "ts": time.time()}
        print(f"[go2_control_ws][{level}] {msg}")
        await _broadcast_payload(payload)

    async def _broadcast_robot_error(op: str, code: int) -> None:
        hint = _code_hint(code)
        payload = {
            "type": "robot_error",
            "op": op,
            "code": int(code),
            "hint": hint,
            "ts": time.time(),
        }
        print(f"[go2_control_ws][robot_error] {op}: code={code} hint={hint}")
        await _broadcast_payload(payload)

    async def _sdk_call(fn: Any, *call_args: Any) -> Any:
        """Run a blocking SDK RPC under an exclusive lock.

        On timeout the caller gets TimeoutError, but the lock is held until the
        worker thread finishes so two Sport/MotionSwitcher RPCs never overlap.
        """
        timeout = max(0.5, float(args.timeout_s) + 0.5)
        async with sdk_lock:
            fut = asyncio.get_running_loop().run_in_executor(None, lambda: fn(*call_args))
            try:
                return await asyncio.wait_for(asyncio.shield(fut), timeout=timeout)
            except asyncio.TimeoutError:
                print(
                    f"[go2_control_ws][warn] SDK call timed out after {timeout:.1f}s "
                    f"({getattr(fn, '__name__', fn)}); waiting for thread to finish"
                )
                try:
                    await fut
                except Exception:
                    pass
                raise

    def _set_vui_color_sync(color: str, time_s: int = 0, flash_cycle: int | None = None) -> int:
        payload: dict[str, Any] = {"color": color, "time": int(time_s)}
        if flash_cycle is not None:
            payload["flash_cycle"] = int(flash_cycle)
        code, _ = vui._Call(VUI_API_ID_SETCOLOR, json.dumps(payload))
        return int(code)

    async def _vui_call(fn: Any, *call_args: Any) -> Any:
        """VUI RPCs use a separate lock so they never block sport.Move."""
        async with vui_lock:
            return await asyncio.wait_for(
                asyncio.to_thread(fn, *call_args),
                timeout=max(0.5, float(args.timeout_s) + 0.5),
            )

    async def _clear_led_hold() -> None:
        async with led_hold_lock:
            led_hold["mode"] = None
            led_hold["color"] = None

    async def _set_led_hold_color(color: str) -> None:
        async with led_hold_lock:
            led_hold["mode"] = "color"
            led_hold["color"] = color

    async def _set_led_hold_off() -> None:
        async with led_hold_lock:
            led_hold["mode"] = "off"
            led_hold["color"] = None

    async def _apply_led_off_sync() -> int:
        # SetSwitch(0) cuts the controllable headlight / color override.
        # Status green ("powered on") is firmware and cannot be extinguished while powered.
        # Do not call SetBrightness(0): that only drops white fill and reveals status RGB.
        return int(await _vui_call(vui.SetSwitch, 0))

    async def _read_vui_light_state() -> tuple[Any, Any]:
        switch_val: Any = None
        bright_val: Any = None
        try:
            sw_code, sw_enable = await _vui_call(vui.GetSwitch)
            if int(sw_code) == 0:
                switch_val = sw_enable
        except Exception:
            pass
        try:
            br_code, br_level = await _vui_call(vui.GetBrightness)
            if int(br_code) == 0:
                bright_val = br_level
        except Exception:
            pass
        return switch_val, bright_val

    async def _run_front_led(ws: Any, *, op_name: str, enable: int) -> None:
        enable_i = 1 if int(enable) else 0
        try:
            if enable_i:
                await _clear_led_hold()
                code_sw = int(await _vui_call(vui.SetSwitch, 1))
                code_br = int(await _vui_call(vui.SetBrightness, 10))
                code = code_br if code_sw == 0 else code_sw
                state_msg = ""
            else:
                await _set_led_hold_off()
                code = int(await _apply_led_off_sync())
                sw, br = await _read_vui_light_state()
                state_msg = f", switch={sw}, brightness={br} (status green may remain)"
        except asyncio.TimeoutError:
            code = 3104
            state_msg = ""
        except Exception as exc:
            async with runtime_lock:
                runtime["last_code"] = -1
                runtime["last_op"] = op_name
                runtime["last_error"] = str(exc)
            await _broadcast_log(f"{op_name}: failed ({exc})", level="warn")
            await _ack(ws, op_name, False, str(exc))
            await _broadcast_status()
            return
        async with runtime_lock:
            runtime["last_code"] = code
            runtime["last_op"] = op_name
            runtime["last_error"] = "" if code == 0 else _code_hint(code)
        if code != 0:
            await _broadcast_robot_error(op_name, code)
        await _ack(ws, op_name, code == 0, f"code={code}, hint={_code_hint(code)}{state_msg}")
        await _broadcast_status()

    async def _run_front_led_brightness(ws: Any, *, level: int) -> None:
        level_i = max(0, min(10, int(level)))
        state_msg = ""
        try:
            if level_i == 0:
                # Same as Off: cut searchlight via switch, not SetBrightness(0).
                await _set_led_hold_off()
                code = int(await _apply_led_off_sync())
                sw, br = await _read_vui_light_state()
                state_msg = f", switch={sw}, brightness={br} (status green may remain)"
            else:
                await _clear_led_hold()
                await _vui_call(vui.SetSwitch, 1)
                code = int(await _vui_call(vui.SetBrightness, level_i))
        except asyncio.TimeoutError:
            code = 3104
        except Exception as exc:
            async with runtime_lock:
                runtime["last_code"] = -1
                runtime["last_op"] = "front_led_brightness"
                runtime["last_error"] = str(exc)
            await _broadcast_log(f"front_led_brightness: failed ({exc})", level="warn")
            await _ack(ws, "front_led_brightness", False, str(exc))
            await _broadcast_status()
            return
        async with runtime_lock:
            runtime["last_code"] = code
            runtime["last_op"] = "front_led_brightness"
            runtime["last_error"] = "" if code == 0 else _code_hint(code)
        if code != 0:
            await _broadcast_robot_error("front_led_brightness", code)
        await _ack(
            ws,
            "front_led_brightness",
            code == 0,
            f"level={level_i}, code={code}, hint={_code_hint(code)}{state_msg}",
        )
        await _broadcast_status()

    async def _run_front_led_color(ws: Any, *, color: str, time_s: int = 0) -> None:
        color_l = str(color).strip().lower()
        if color_l not in VUI_COLORS:
            await _ack(ws, "front_led_color", False, f"invalid color (use one of: {', '.join(sorted(VUI_COLORS))})")
            return
        # time<=0 means hold; API requires a positive duration before reverting to green.
        hold = int(time_s) <= 0
        duration_s = VUI_COLOR_HOLD_S if hold else max(1, int(time_s))
        try:
            await _vui_call(vui.SetSwitch, 1)
            code = int(await _vui_call(_set_vui_color_sync, color_l, duration_s))
        except asyncio.TimeoutError:
            code = 3104
        except Exception as exc:
            async with runtime_lock:
                runtime["last_code"] = -1
                runtime["last_op"] = "front_led_color"
                runtime["last_error"] = str(exc)
            await _broadcast_log(f"front_led_color: failed ({exc})", level="warn")
            await _ack(ws, "front_led_color", False, str(exc))
            await _broadcast_status()
            return
        if code == 0 and hold:
            await _set_led_hold_color(color_l)
        elif code == 0:
            await _clear_led_hold()
        async with runtime_lock:
            runtime["last_code"] = code
            runtime["last_op"] = "front_led_color"
            runtime["last_error"] = "" if code == 0 else _code_hint(code)
        if code != 0:
            await _broadcast_robot_error("front_led_color", code)
        await _ack(
            ws,
            "front_led_color",
            code == 0,
            f"color={color_l}, time={duration_s}, hold={hold}, code={code}, hint={_code_hint(code)}",
        )
        await _broadcast_status()

    async def _ensure_normal_mode() -> tuple[bool, str]:
        try:
            check_code, payload = await _sdk_call(motion.CheckMode)
        except asyncio.TimeoutError:
            message = "CheckMode timed out"
            if args.strict_normal_mode:
                return False, message
            return True, f"WARNING: {message}; continuing anyway"
        if check_code == 0 and _looks_like_normal_mode(payload):
            return True, "normal mode already active"
        try:
            select_code, _ = await _sdk_call(motion.SelectMode, "normal")
        except asyncio.TimeoutError:
            message = "SelectMode(normal) timed out"
            if args.strict_normal_mode:
                return False, message
            return True, f"WARNING: {message}; continuing anyway"
        if select_code != 0:
            message = f"SelectMode(normal) failed: code={select_code}, hint={_code_hint(select_code)}"
            if args.strict_normal_mode:
                return False, message
            return True, f"WARNING: {message}; continuing anyway"
        return True, "normal mode activated"

    async def _rearm_sport_light(*, reason: str = "") -> tuple[bool, str]:
        """Lightweight sport rearm (StopMove + normal mode + probe). No teach/lowcmd."""
        notes: list[str] = []
        if reason:
            notes.append(reason)
        try:
            stop_code = int(await _sdk_call(sport.StopMove))
            notes.append(f"StopMove={stop_code}")
        except asyncio.TimeoutError:
            notes.append("StopMove=timeout")
        except Exception as exc:
            notes.append(f"StopMove={exc}")

        ok_mode, mode_msg = await _ensure_normal_mode()
        notes.append(mode_msg)
        if not ok_mode:
            return False, "rearm failed: " + "; ".join(notes)

        try:
            probe = int(await _sdk_call(sport.StopMove))
            notes.append(f"probe={probe}")
            ok = probe == 0 or not args.strict_normal_mode
        except asyncio.TimeoutError:
            notes.append("probe=timeout")
            ok = not args.strict_normal_mode
        except Exception as exc:
            notes.append(f"probe={exc}")
            ok = False
        return ok, "rearm: " + "; ".join(notes)

    async def _pause_control_loop(duration_s: float) -> None:
        until = time.monotonic() + max(0.0, float(duration_s))
        async with control_gate_lock:
            if until > float(control_gate["until_ts"]):
                control_gate["until_ts"] = until

    async def _require_posture_pilot(ws: Any, typ: str) -> bool:
        async with pilot_lock:
            is_pilot = pilot["ws"] is ws
        if is_pilot:
            return True
        await _broadcast_log(f"{typ}: rejected (claim posture pilot first)", level="warn")
        await _ack(ws, str(typ), False, "not posture pilot — send claim_pilot first")
        await _broadcast_status()
        return False

    async def _run_posture_command(ws: Any, *, op_name: str, sdk_call: Any) -> None:
        if not await _require_posture_pilot(ws, op_name):
            return
        async with posture_op_lock:
            await _broadcast_log(f"{op_name}: start", level="info")
            await clear_all_targets()
            await _pause_control_loop(max(args.posture_guard_s, args.control_period * 2))
            try:
                stop_code = int(await _sdk_call(sport.StopMove))
            except asyncio.TimeoutError:
                await _broadcast_log(f"{op_name}: pre-stop timed out", level="warn")
                await _ack(ws, op_name, False, "pre-stop timed out")
                await _broadcast_status()
                return
            if stop_code != 0:
                async with runtime_lock:
                    runtime["last_code"] = stop_code
                    runtime["last_op"] = f"{op_name}_pre_stop"
                    runtime["last_error"] = _code_hint(stop_code)
                message = f"{op_name}: pre-stop failed code={stop_code} hint={_code_hint(stop_code)}"
                if args.strict_pre_stop:
                    await _broadcast_log(message, level="warn")
                    await _ack(
                        ws,
                        op_name,
                        False,
                        f"pre-stop failed: code={stop_code}, hint={_code_hint(stop_code)}",
                    )
                    await _broadcast_status()
                    return
                await _broadcast_log(f"{message} (continuing anyway)", level="warn")

            # Rearm for stand + recovery; other postures only need normal mode.
            needs_rearm = op_name in ("stand_up", "stand_down", "recovery_stand")
            if needs_rearm:
                ok_rearm, rearm_msg = await _rearm_sport_light(reason=f"pre-{op_name}")
                await _broadcast_log(f"{op_name}: {rearm_msg}", level="info" if ok_rearm else "warn")
                if not ok_rearm and args.strict_normal_mode:
                    await _ack(ws, op_name, False, rearm_msg)
                    async with runtime_lock:
                        runtime["last_code"] = -1
                        runtime["last_op"] = op_name
                        runtime["last_error"] = rearm_msg
                    await _broadcast_status()
                    return
            else:
                ok_mode, mode_msg = await _ensure_normal_mode()
                if not ok_mode:
                    await _broadcast_log(f"{op_name}: normal mode failed ({mode_msg})", level="warn")
                    await _ack(ws, op_name, False, mode_msg)
                    async with runtime_lock:
                        runtime["last_code"] = -1
                        runtime["last_op"] = op_name
                        runtime["last_error"] = mode_msg
                    await _broadcast_status()
                    return

            if args.pre_posture_delay_s > 0:
                await asyncio.sleep(args.pre_posture_delay_s)

            async def _invoke() -> int:
                return int(await _sdk_call(sdk_call))

            try:
                code = await _invoke()
            except asyncio.TimeoutError:
                await _broadcast_log(f"{op_name}: timed out", level="warn")
                await _ack(ws, op_name, False, "SDK call timed out")
                await _broadcast_status()
                return

            # Hard retry on stale-sport codes (includes intentional recovery_stand).
            if needs_rearm and code in {3102, 4205, -1}:
                await _broadcast_log(
                    f"{op_name}: code={code} hint={_code_hint(code)}; rearm + retry",
                    level="warn",
                )
                await _pause_control_loop(args.posture_guard_s)
                ok_rearm, rearm_msg = await _rearm_sport_light(reason=f"retry-{op_name}")
                await _broadcast_log(f"{op_name}: {rearm_msg}", level="info" if ok_rearm else "warn")
                # For stand_up/stand_down, kick with RecoveryStand before retry.
                # For recovery_stand itself, skip the extra RecoveryStand (we're already retrying it).
                if op_name != "recovery_stand":
                    try:
                        rec = int(await _sdk_call(sport.RecoveryStand))
                        await _broadcast_log(f"{op_name}: RecoveryStand code={rec}", level="info")
                    except Exception as exc:
                        await _broadcast_log(f"{op_name}: RecoveryStand failed ({exc})", level="warn")
                    await asyncio.sleep(max(0.35, float(args.pre_posture_delay_s)))
                try:
                    code = await _invoke()
                except asyncio.TimeoutError:
                    await _broadcast_log(f"{op_name}: retry timed out", level="warn")
                    await _ack(ws, op_name, False, "SDK call timed out on retry")
                    await _broadcast_status()
                    return

            # StandDown ACK-without-motion mitigation: second StandDown only (no RecoveryStand).
            if op_name == "stand_down" and code == 0:
                await _broadcast_log(f"{op_name}: second StandDown (no RecoveryStand)", level="info")
                await _pause_control_loop(args.posture_guard_s)
                await asyncio.sleep(max(0.15, float(args.pre_posture_delay_s)))
                try:
                    code2 = await _invoke()
                    if code2 != 0:
                        await _broadcast_log(
                            f"{op_name}: second StandDown code={code2} hint={_code_hint(code2)}",
                            level="warn",
                        )
                        code = code2
                except asyncio.TimeoutError:
                    await _broadcast_log(f"{op_name}: second StandDown timed out", level="warn")
                    # Keep first success — robot should still be lying / commanded down.

            await _pause_control_loop(args.posture_guard_s)
            async with runtime_lock:
                runtime["last_code"] = code
                runtime["last_op"] = op_name
                runtime["last_error"] = "" if code == 0 else _code_hint(code)
            if code == 0:
                await _broadcast_log(f"{op_name}: success", level="info")
            else:
                await _broadcast_log(
                    f"{op_name}: failed code={code} hint={_code_hint(code)}",
                    level="warn",
                )
                await _broadcast_robot_error(op_name, code)
            await _ack(ws, op_name, code == 0, f"code={code}, hint={_code_hint(code)}")
            await _broadcast_status()

    async def _do_claim_pilot(ws: Any) -> None:
        async with pilot_lock:
            current = pilot["ws"]
            if current is not None and current is not ws:
                await _broadcast_log("claim_pilot denied: already owned by another client", level="warn")
                await _ack(ws, "claim_pilot", False, "posture pilot already claimed")
                await _broadcast_status()
                return
        ok_mode, mode_msg = await _ensure_normal_mode()
        if not ok_mode:
            await _broadcast_log(f"claim_pilot denied: {mode_msg}", level="warn")
            await _ack(ws, "claim_pilot", False, mode_msg)
            async with runtime_lock:
                runtime["last_code"] = -1
                runtime["last_op"] = "claim_pilot"
                runtime["last_error"] = mode_msg
            await _broadcast_status()
            return
        async with pilot_lock:
            pilot["ws"] = ws
        await clear_client_target(ws)
        await _broadcast_log("posture pilot granted", level="info")
        if mode_msg.startswith("WARNING:"):
            await _ack(ws, "claim_pilot", True, f"posture pilot granted ({mode_msg})")
        else:
            await _ack(ws, "claim_pilot", True, "posture pilot granted")
        await _broadcast_status()

    async def _do_release_pilot(ws: Any) -> None:
        async with pilot_lock:
            if pilot["ws"] is ws:
                pilot["ws"] = None
        await clear_client_target(ws)
        await _broadcast_log("posture pilot released", level="info")
        await _ack(ws, "release_pilot", True)
        await _broadcast_status()

    async def _do_normal_mode(ws: Any) -> None:
        if not await _require_posture_pilot(ws, "normal_mode"):
            return
        ok_mode, mode_msg = await _ensure_normal_mode()
        async with runtime_lock:
            runtime["last_code"] = 0 if ok_mode else -1
            runtime["last_op"] = "normal_mode"
            runtime["last_error"] = "" if ok_mode else mode_msg
        await _ack(ws, "normal_mode", ok_mode, mode_msg)
        await _broadcast_status()

    async def handler(ws: Any) -> None:
        ra = _client_label(ws)
        print(f"[go2_control_ws] client connected: {ra}")
        async with clients_lock:
            clients.add(ws)
        await _broadcast_log(f"client connected: {ra}", level="info")
        await _send_json(
            ws,
            {
                "type": "hello",
                "iface": args.iface,
                "bridge": "go2_control_ws_bridge",
                "protocol": 2,
                "multi_control": bool(args.multi_control),
                "commands": [
                    "claim_pilot",
                    "release_pilot",
                    "normal_mode",
                    "stand_up",
                    "stand_down",
                    "balance_stand",
                    "recovery_stand",
                    "stop",
                    "twist",
                    "shutdown_pi",
                    "front_led",
                    "front_led_on",
                    "front_led_off",
                    "front_led_brightness",
                    "front_led_color",
                ],
            },
        )
        # Do not block entering the recv loop on status (or a stuck peer send).
        async def _push_initial_status() -> None:
            try:
                await _send_json(ws, await _build_status_payload(for_ws=ws))
            except Exception:
                pass

        asyncio.create_task(_push_initial_status())

        try:
            async for raw in ws:
                try:
                    data = json.loads(raw)
                except Exception:
                    await _send_json(ws, {"type": "error", "msg": "invalid json"})
                    continue
                if not isinstance(data, dict):
                    await _send_json(ws, {"type": "error", "msg": "json object expected"})
                    continue

                typ = data.get("type")
                if typ == "ping":
                    await _send_json(
                        ws,
                        {
                            "type": "pong",
                            "seq": data.get("seq"),
                            "client_ts_ms": data.get("client_ts_ms"),
                            "server_ts": time.time(),
                        },
                    )
                    continue

                if typ == "claim_pilot":
                    asyncio.create_task(_do_claim_pilot(ws))
                    continue

                if typ == "release_pilot":
                    asyncio.create_task(_do_release_pilot(ws))
                    continue

                # Host power management: any connected client (no posture pilot).
                if typ == "shutdown_pi":
                    await _broadcast_log("host shutdown requested", level="info")
                    await _ack(ws, "shutdown_pi", True, "host shutdown scheduled")

                    async def _do_host_shutdown() -> None:
                        await asyncio.sleep(1.0)
                        try:
                            proc = await asyncio.create_subprocess_exec(
                                "sudo",
                                "/sbin/shutdown",
                                "-h",
                                "now",
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE,
                            )
                            stdout, stderr = await proc.communicate()
                            if proc.returncode != 0:
                                err = (stderr or stdout or b"").decode("utf-8", errors="replace").strip()
                                await _broadcast_log(
                                    f"shutdown_pi failed: {err or f'exit={proc.returncode}'}",
                                    level="warn",
                                )
                        except Exception as exc:
                            await _broadcast_log(f"shutdown_pi failed: {exc}", level="warn")

                    asyncio.create_task(_do_host_shutdown())
                    continue

                # Front LED (VUI): run in background so DDS/VUI RPC cannot stall WS reads/pongs/twists.
                if typ in ("front_led_on", "front_led_off", "front_led"):
                    if typ == "front_led_on":
                        enable = 1
                        op_name = "front_led_on"
                    elif typ == "front_led_off":
                        enable = 0
                        op_name = "front_led_off"
                    else:
                        enable = 1 if int(_safe_float(data.get("enable", 0), default=0)) else 0
                        op_name = "front_led"
                    asyncio.create_task(_run_front_led(ws, op_name=op_name, enable=enable))
                    continue

                if typ == "front_led_brightness":
                    level = int(_safe_float(data.get("level", 5), default=5))
                    asyncio.create_task(_run_front_led_brightness(ws, level=level))
                    continue

                if typ == "front_led_color":
                    color = str(data.get("color", "") or "")
                    time_s = int(_safe_float(data.get("time", 0), default=0))
                    asyncio.create_task(_run_front_led_color(ws, color=color, time_s=time_s))
                    continue

                # twist / stop: any connected client when multi_control (default).
                if typ in ("twist", "stop") and args.multi_control:
                    if typ == "stop":
                        await clear_client_target(ws)

                        async def _stop_move_task() -> None:
                            try:
                                code = int(await _sdk_call(sport.StopMove))
                            except Exception as exc:
                                await _ack(ws, "stop", False, str(exc))
                                return
                            async with runtime_lock:
                                runtime["last_code"] = code
                                runtime["last_op"] = "stop"
                                runtime["last_error"] = "" if code == 0 else _code_hint(code)
                            if code != 0:
                                await _broadcast_robot_error("stop", code)
                            await _ack(ws, "stop", code == 0, f"code={code}, hint={_code_hint(code)}")
                            await _broadcast_status()

                        asyncio.create_task(_stop_move_task())
                        continue

                    vx = _safe_float(data.get("vx", 0.0))
                    vy = _safe_float(data.get("vy", 0.0))
                    vyaw = _safe_float(data.get("vyaw", 0.0))
                    vx = max(-args.max_vx, min(args.max_vx, vx))
                    vy = max(-args.max_vy, min(args.max_vy, vy))
                    vyaw = max(-args.max_vyaw, min(args.max_vyaw, vyaw))
                    await set_client_target(ws, vx, vy, vyaw)
                    await _ack(ws, "twist", True, f"target=({vx:+.2f},{vy:+.2f},{vyaw:+.2f})")
                    continue

                # Legacy single-pilot mode or posture commands require pilot.
                async with pilot_lock:
                    is_pilot = pilot["ws"] is ws
                if not is_pilot:
                    await _broadcast_log(f"{typ}: rejected (client is not posture pilot)", level="warn")
                    await _ack(ws, str(typ), False, "not posture pilot")
                    continue

                if typ == "stand_up":
                    asyncio.create_task(_run_posture_command(ws, op_name="stand_up", sdk_call=sport.StandUp))
                elif typ == "stand_down":
                    asyncio.create_task(_run_posture_command(ws, op_name="stand_down", sdk_call=sport.StandDown))
                elif typ == "normal_mode":
                    asyncio.create_task(_do_normal_mode(ws))
                elif typ == "balance_stand":
                    asyncio.create_task(
                        _run_posture_command(ws, op_name="balance_stand", sdk_call=sport.BalanceStand)
                    )
                elif typ == "recovery_stand":
                    asyncio.create_task(
                        _run_posture_command(ws, op_name="recovery_stand", sdk_call=sport.RecoveryStand)
                    )
                elif typ == "stop":
                    await clear_client_target(ws)

                    async def _legacy_stop_task() -> None:
                        try:
                            code = int(await _sdk_call(sport.StopMove))
                        except Exception as exc:
                            await _ack(ws, "stop", False, str(exc))
                            return
                        async with runtime_lock:
                            runtime["last_code"] = code
                            runtime["last_op"] = "stop"
                            runtime["last_error"] = "" if code == 0 else _code_hint(code)
                        if code != 0:
                            await _broadcast_robot_error("stop", code)
                        await _ack(ws, "stop", code == 0, f"code={code}, hint={_code_hint(code)}")
                        await _broadcast_status()

                    asyncio.create_task(_legacy_stop_task())
                elif typ == "twist":
                    vx = _safe_float(data.get("vx", 0.0))
                    vy = _safe_float(data.get("vy", 0.0))
                    vyaw = _safe_float(data.get("vyaw", 0.0))
                    vx = max(-args.max_vx, min(args.max_vx, vx))
                    vy = max(-args.max_vy, min(args.max_vy, vy))
                    vyaw = max(-args.max_vyaw, min(args.max_vyaw, vyaw))
                    await set_client_target(ws, vx, vy, vyaw)
                    await _ack(ws, "twist", True, f"target=({vx:+.2f},{vy:+.2f},{vyaw:+.2f})")
                else:
                    await _broadcast_log(f"unknown command type: {typ}", level="warn")
                    await _send_json(ws, {"type": "error", "msg": f"unknown type: {typ}"})
                    continue
        except ConnectionClosed as exc:
            print(f"[go2_control_ws] client disconnected ({ra}): code={exc.code} reason={exc.reason!r}")
        finally:
            async with clients_lock:
                clients.discard(ws)
            async with pilot_lock:
                if pilot["ws"] is ws:
                    pilot["ws"] = None
            await clear_client_target(ws)
            try:
                await _sdk_call(sport.StopMove)
            except Exception:
                pass
            await _broadcast_status()
            await _broadcast_log(f"client disconnected: {ra}", level="info")
            print(f"[go2_control_ws] client disconnected: {ra}")

    async def control_loop() -> None:
        loop_state: dict[str, Any] = {
            "last_kind": "none",
            "last_stop_ts": 0.0,
            "last_error_code": 0,
            "error_streak": 0,
            "last_rearm_ts": 0.0,
        }
        rearm_codes = {3102, 4202, 4205, -1, -2}
        rearm_streak = 3
        rearm_cooldown_s = 5.0

        while True:
            await asyncio.sleep(args.control_period)
            async with control_gate_lock:
                if time.monotonic() < float(control_gate["until_ts"]):
                    continue

            async with clients_lock:
                n_clients = len(clients)
            if n_clients == 0:
                continue

            if not args.multi_control:
                async with pilot_lock:
                    if pilot["ws"] is None:
                        continue

            vx, vy, vyaw, _controller = await resolve_active_target()
            now = time.monotonic()

            try:
                if vx == 0.0 and vy == 0.0 and vyaw == 0.0:
                    if (
                        loop_state["last_kind"] == "zero"
                        and now - float(loop_state["last_stop_ts"]) < args.idle_stop_period
                    ):
                        continue
                    code = int(await _sdk_call(sport.StopMove))
                    op = "stop_move_loop"
                    loop_state["last_kind"] = "zero"
                    loop_state["last_stop_ts"] = now
                else:
                    code = int(await _sdk_call(sport.Move, vx, vy, vyaw))
                    op = "move_loop"
                    loop_state["last_kind"] = "move"

                async with runtime_lock:
                    runtime["last_code"] = code
                    runtime["last_op"] = op
                    runtime["last_move_ts"] = time.monotonic()
                    runtime["last_error"] = "" if code == 0 else _code_hint(code)

                if code != 0:
                    if code != loop_state.get("last_error_code"):
                        loop_state["last_error_code"] = code
                        await _broadcast_log(f"{op}: code={code} hint={_code_hint(code)}", level="warn")
                        await _broadcast_robot_error(op, code)
                    if code in rearm_codes:
                        loop_state["error_streak"] = int(loop_state["error_streak"]) + 1
                    else:
                        loop_state["error_streak"] = 0
                else:
                    loop_state["last_error_code"] = 0
                    loop_state["error_streak"] = 0

                if (
                    int(loop_state["error_streak"]) >= rearm_streak
                    and now - float(loop_state["last_rearm_ts"]) >= rearm_cooldown_s
                ):
                    loop_state["error_streak"] = 0
                    loop_state["last_rearm_ts"] = now
                    await _pause_control_loop(0.4)
                    await _broadcast_log(f"{op}: auto-rearm after repeated errors", level="warn")
                    ok_rearm, rearm_msg = await _rearm_sport_light(reason="move_loop auto-rearm")
                    await _broadcast_log(
                        f"move_loop: {rearm_msg}",
                        level="info" if ok_rearm else "warn",
                    )
            except Exception as exc:
                async with runtime_lock:
                    runtime["last_code"] = -2
                    runtime["last_op"] = "move_exception"
                    runtime["last_error"] = str(exc)
                loop_state["error_streak"] = int(loop_state["error_streak"]) + 1
                await _broadcast_log(f"move loop exception: {exc}", level="warn")
                await _broadcast_robot_error("move_exception", -2)
                now = time.monotonic()
                if (
                    int(loop_state["error_streak"]) >= rearm_streak
                    and now - float(loop_state["last_rearm_ts"]) >= rearm_cooldown_s
                ):
                    loop_state["error_streak"] = 0
                    loop_state["last_rearm_ts"] = now
                    await _pause_control_loop(0.4)
                    await _broadcast_log("move_loop: auto-rearm after exceptions", level="warn")
                    ok_rearm, rearm_msg = await _rearm_sport_light(reason="move_exception auto-rearm")
                    await _broadcast_log(
                        f"move_loop: {rearm_msg}",
                        level="info" if ok_rearm else "warn",
                    )

    async def stats_loop() -> None:
        while True:
            await asyncio.sleep(1.0)
            await _broadcast_status()

    async def led_hold_loop() -> None:
        """Re-apply held searchlight off / color. Status green is firmware and may remain."""
        while True:
            async with led_hold_lock:
                mode = led_hold["mode"]
            # Off: keep SetSwitch(0) so headlight/color does not come back.
            await asyncio.sleep(2.0 if mode == "off" else VUI_COLOR_REFRESH_S)
            async with led_hold_lock:
                mode = led_hold["mode"]
                color = led_hold["color"]
            if mode == "off":
                try:
                    code = int(await _apply_led_off_sync())
                    if code != 0:
                        await _broadcast_log(
                            f"led_off refresh failed code={code} hint={_code_hint(code)}",
                            level="warn",
                        )
                except Exception as exc:
                    await _broadcast_log(f"led_off refresh exception: {exc}", level="warn")
            elif mode == "color" and color:
                try:
                    await _vui_call(vui.SetSwitch, 1)
                    code = int(await _vui_call(_set_vui_color_sync, str(color), VUI_COLOR_HOLD_S))
                    if code != 0:
                        await _broadcast_log(
                            f"color_hold refresh failed color={color} code={code} hint={_code_hint(code)}",
                            level="warn",
                        )
                except Exception as exc:
                    await _broadcast_log(f"color_hold refresh exception: {exc}", level="warn")

    serve_kw: dict[str, Any] = {
        "ping_interval": args.ws_ping_interval if args.ws_ping_interval > 0 else None,
        "ping_timeout": args.ws_ping_timeout if args.ws_ping_timeout > 0 else None,
    }
    mode = "multi" if args.multi_control else "single-pilot"
    print(f"[go2_control_ws] ws://{args.host}:{args.port} iface={args.iface} mode={mode}")
    try:
        async with websockets.serve(handler, args.host, args.port, **serve_kw):
            await asyncio.gather(control_loop(), stats_loop(), led_hold_loop())
    except OSError as exc:
        if exc.errno == 98:
            raise SystemExit(
                f"Port {args.port} already in use. Stop the existing bridge/process or use --port <other>."
            ) from exc
        raise


def main() -> None:
    p = argparse.ArgumentParser(description="GO2 control WebSocket bridge (DDS sport RPC backend)")
    p.add_argument("--iface", required=True, help="Network interface (example: eth0)")
    p.add_argument("--host", default="0.0.0.0", help="WebSocket bind host")
    p.add_argument("--port", type=int, default=8766, help="WebSocket port")
    p.add_argument("--timeout-s", type=float, default=3.0, help="RPC timeout")
    p.add_argument("--control-period", type=float, default=0.05, help="Control loop period (s)")
    p.add_argument("--command-timeout", type=float, default=0.35, help="Auto-stop if no twist refresh (s)")
    p.add_argument("--max-vx", type=float, default=0.6, help="Clamp forward speed m/s")
    p.add_argument("--max-vy", type=float, default=0.4, help="Clamp lateral speed m/s")
    p.add_argument("--max-vyaw", type=float, default=1.2, help="Clamp yaw speed rad/s")
    p.add_argument(
        "--multi-control",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Allow any connected client to send twist/stop (last-writer-wins). Posture still needs claim_pilot.",
    )
    p.add_argument(
        "--posture-guard-s",
        type=float,
        default=1.2,
        help="Pause move loop around posture commands (stand/recovery/balance).",
    )
    p.add_argument(
        "--pre-posture-delay-s",
        type=float,
        default=0.10,
        help="Small delay between StopMove and posture command.",
    )
    p.add_argument(
        "--strict-normal-mode",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Fail claim/commands if normal mode cannot be enforced (default: false).",
    )
    p.add_argument(
        "--ws-ping-interval",
        type=float,
        default=0.0,
        help="WS protocol ping interval (s), <=0 to disable (app-level ping still works).",
    )
    p.add_argument("--ws-ping-timeout", type=float, default=60.0, help="WS ping timeout (s), <=0 to disable")
    p.add_argument(
        "--idle-stop-period",
        type=float,
        default=0.40,
        help="When idle target=0, minimum interval between StopMove calls (s).",
    )
    p.add_argument(
        "--strict-pre-stop",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Fail posture commands if pre-stop fails (default: continue anyway).",
    )
    args = p.parse_args()
    asyncio.run(_amain(args))


if __name__ == "__main__":
    main()
