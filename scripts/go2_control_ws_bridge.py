#!/usr/bin/env python3
"""
Simple GO2 control bridge (DDS sport RPC <-> WebSocket JSON).

WebSocket protocol:
  - server -> client:
      {"type":"hello","iface":"eth0"}
      {"type":"ack","cmd":"stand_up","ok":true}
      {"type":"status","pilot":true,"vx":0.2,"vy":0.0,"vyaw":0.0}
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
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import time
from typing import Any


_CODE_HINTS = {
    -1: "SDK/robot service rejected command (often stale sport state or mode mismatch).",
    0: "OK",
    3102: "DDS send failed (check iface/cable).",
    3104: "RPC timeout.",
    3203: "API unsupported by firmware.",
    3204: "Invalid argument.",
    4202: "sport service not initialized.",
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


async def _amain(args: argparse.Namespace) -> None:
    try:
        import websockets
        from websockets.exceptions import ConnectionClosed
        from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import MotionSwitcherClient
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize
        from unitree_sdk2py.go2.sport.sport_client import SportClient
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

    clients: set[Any] = set()
    clients_lock = asyncio.Lock()
    pilot: dict[str, Any] = {"ws": None}
    pilot_lock = asyncio.Lock()

    target = {"vx": 0.0, "vy": 0.0, "vyaw": 0.0, "ts": 0.0}
    target_lock = asyncio.Lock()
    runtime = {"last_code": 0, "last_op": "init", "last_error": "", "last_move_ts": 0.0}
    runtime_lock = asyncio.Lock()
    sdk_lock = asyncio.Lock()
    control_gate = {"until_ts": 0.0}
    control_gate_lock = asyncio.Lock()

    async def set_target(vx: float, vy: float, vyaw: float) -> None:
        async with target_lock:
            target["vx"] = float(vx)
            target["vy"] = float(vy)
            target["vyaw"] = float(vyaw)
            target["ts"] = time.monotonic()

    async def _send_json(ws: Any, payload: dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(payload))
        except Exception:
            pass

    async def _ack(ws: Any, cmd: str, ok: bool, msg: str | None = None) -> None:
        payload: dict[str, Any] = {"type": "ack", "cmd": cmd, "ok": bool(ok)}
        if msg:
            payload["msg"] = msg
        await _send_json(ws, payload)

    async def _broadcast_log(msg: str, *, level: str = "info") -> None:
        payload = {"type": "log", "level": str(level), "msg": str(msg), "ts": time.time()}
        print(f"[go2_control_ws][{level}] {msg}")
        async with clients_lock:
            dead: list[Any] = []
            for c in clients:
                try:
                    await c.send(json.dumps(payload))
                except Exception:
                    dead.append(c)
            for c in dead:
                clients.discard(c)

    async def _broadcast_status() -> None:
        async with target_lock:
            vx = float(target["vx"])
            vy = float(target["vy"])
            vyaw = float(target["vyaw"])
        async with pilot_lock:
            has_pilot = pilot["ws"] is not None
        async with runtime_lock:
            last_code = int(runtime["last_code"])
            last_op = str(runtime["last_op"])
            last_error = str(runtime["last_error"])

        payload = {
            "type": "status",
            "pilot": has_pilot,
            "vx": vx,
            "vy": vy,
            "vyaw": vyaw,
            "last_code": last_code,
            "last_op": last_op,
            "last_error": last_error,
        }
        async with clients_lock:
            dead: list[Any] = []
            for c in clients:
                try:
                    await c.send(json.dumps(payload))
                except Exception:
                    dead.append(c)
            for c in dead:
                clients.discard(c)

    async def _sdk_call(fn: Any, *call_args: Any) -> Any:
        async with sdk_lock:
            return await asyncio.to_thread(fn, *call_args)

    async def _ensure_normal_mode() -> tuple[bool, str]:
        check_code, payload = await _sdk_call(motion.CheckMode)
        if check_code == 0 and _looks_like_normal_mode(payload):
            return True, "normal mode already active"
        select_code, _ = await _sdk_call(motion.SelectMode, "normal")
        if select_code != 0:
            message = f"SelectMode(normal) failed: code={select_code}, hint={_code_hint(select_code)}"
            if args.strict_normal_mode:
                return False, message
            return True, f"WARNING: {message}; continuing anyway"
        return True, "normal mode activated"

    async def _pause_control_loop(duration_s: float) -> None:
        until = time.monotonic() + max(0.0, float(duration_s))
        async with control_gate_lock:
            if until > float(control_gate["until_ts"]):
                control_gate["until_ts"] = until

    async def _run_posture_command(ws: Any, *, op_name: str, sdk_call: Any) -> None:
        await _broadcast_log(f"{op_name}: start", level="info")
        await set_target(0.0, 0.0, 0.0)
        await _pause_control_loop(max(args.posture_guard_s, args.control_period * 2))
        stop_code = int(await _sdk_call(sport.StopMove))
        if stop_code != 0:
            async with runtime_lock:
                runtime["last_code"] = stop_code
                runtime["last_op"] = f"{op_name}_pre_stop"
                runtime["last_error"] = _code_hint(stop_code)
            message = f"{op_name}: pre-stop failed code={stop_code} hint={_code_hint(stop_code)}"
            if args.strict_pre_stop:
                await _broadcast_log(message, level="warn")
                await _ack(ws, op_name, False, f"pre-stop failed: code={stop_code}, hint={_code_hint(stop_code)}")
                await _broadcast_status()
                return
            await _broadcast_log(f"{message} (continuing anyway)", level="warn")

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
        code = int(await _sdk_call(sdk_call))

        await _pause_control_loop(args.posture_guard_s)
        async with runtime_lock:
            runtime["last_code"] = code
            runtime["last_op"] = op_name
            runtime["last_error"] = "" if code == 0 else _code_hint(code)
        if code == 0:
            await _broadcast_log(f"{op_name}: success", level="info")
        else:
            await _broadcast_log(f"{op_name}: failed code={code} hint={_code_hint(code)}", level="warn")
        await _ack(ws, op_name, code == 0, f"code={code}, hint={_code_hint(code)}")
        await _broadcast_status()

    async def handler(ws: Any) -> None:
        ra = getattr(ws, "remote_address", "?")
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
                "protocol": 1,
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
                ],
            },
        )

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
                    async with pilot_lock:
                        current = pilot["ws"]
                        if current is not None and current is not ws:
                            await _broadcast_log("claim_pilot denied: already owned by another client", level="warn")
                            await _ack(ws, "claim_pilot", False, "pilot already claimed by another client")
                            await _broadcast_status()
                            continue
                    ok_mode, mode_msg = await _ensure_normal_mode()
                    if not ok_mode:
                        await _broadcast_log(f"claim_pilot denied: {mode_msg}", level="warn")
                        await _ack(ws, "claim_pilot", False, mode_msg)
                        async with runtime_lock:
                            runtime["last_code"] = -1
                            runtime["last_op"] = "claim_pilot"
                            runtime["last_error"] = mode_msg
                        await _broadcast_status()
                        continue
                    async with pilot_lock:
                        pilot["ws"] = ws
                    await set_target(0.0, 0.0, 0.0)
                    await _broadcast_log("pilot granted", level="info")
                    if mode_msg.startswith("WARNING:"):
                        await _ack(ws, "claim_pilot", True, f"pilot granted ({mode_msg})")
                    else:
                        await _ack(ws, "claim_pilot", True, "pilot granted")
                    await _broadcast_status()
                    continue

                if typ == "release_pilot":
                    async with pilot_lock:
                        if pilot["ws"] is ws:
                            pilot["ws"] = None
                    await set_target(0.0, 0.0, 0.0)
                    await _broadcast_log("pilot released", level="info")
                    await _ack(ws, "release_pilot", True)
                    await _broadcast_status()
                    continue

                async with pilot_lock:
                    is_pilot = pilot["ws"] is ws
                if not is_pilot:
                    await _broadcast_log(f"{typ}: rejected (client is not pilot)", level="warn")
                    await _ack(ws, str(typ), False, "not pilot")
                    continue

                if typ == "stand_up":
                    await _run_posture_command(ws, op_name="stand_up", sdk_call=sport.StandUp)
                elif typ == "stand_down":
                    await _run_posture_command(ws, op_name="stand_down", sdk_call=sport.StandDown)
                elif typ == "normal_mode":
                    ok_mode, mode_msg = await _ensure_normal_mode()
                    async with runtime_lock:
                        runtime["last_code"] = 0 if ok_mode else -1
                        runtime["last_op"] = "normal_mode"
                        runtime["last_error"] = "" if ok_mode else mode_msg
                    await _ack(ws, "normal_mode", ok_mode, mode_msg)
                    await _broadcast_status()
                elif typ == "balance_stand":
                    await _run_posture_command(ws, op_name="balance_stand", sdk_call=sport.BalanceStand)
                elif typ == "recovery_stand":
                    await _run_posture_command(ws, op_name="recovery_stand", sdk_call=sport.RecoveryStand)
                elif typ == "stop":
                    await set_target(0.0, 0.0, 0.0)
                    code = int(await _sdk_call(sport.StopMove))
                    async with runtime_lock:
                        runtime["last_code"] = code
                        runtime["last_op"] = "stop"
                        runtime["last_error"] = "" if code == 0 else _code_hint(code)
                    if code == 0:
                        await _broadcast_log("stop: success", level="info")
                    else:
                        await _broadcast_log(f"stop: failed code={code} hint={_code_hint(code)}", level="warn")
                    await _ack(ws, "stop", code == 0, f"code={code}, hint={_code_hint(code)}")
                    await _broadcast_status()
                elif typ == "twist":
                    vx = _safe_float(data.get("vx", 0.0))
                    vy = _safe_float(data.get("vy", 0.0))
                    vyaw = _safe_float(data.get("vyaw", 0.0))
                    vx = max(-args.max_vx, min(args.max_vx, vx))
                    vy = max(-args.max_vy, min(args.max_vy, vy))
                    vyaw = max(-args.max_vyaw, min(args.max_vyaw, vyaw))
                    await set_target(vx, vy, vyaw)
                    await _ack(ws, "twist", True, f"target=({vx:+.2f},{vy:+.2f},{vyaw:+.2f})")
                else:
                    # Do not fail the connection on schema drifts; keep socket alive.
                    await _broadcast_log(f"unknown command type: {typ}", level="warn")
                    await _send_json(ws, {"type": "error", "msg": f"unknown type: {typ}"})
                    continue
        except ConnectionClosed as exc:
            # Expected on flaky links / browser refresh; avoid noisy traceback + 1011 loops.
            print(f"[go2_control_ws] client disconnected ({ra}): code={exc.code} reason={exc.reason!r}")
        finally:
            async with clients_lock:
                clients.discard(ws)
            async with pilot_lock:
                if pilot["ws"] is ws:
                    pilot["ws"] = None
            await set_target(0.0, 0.0, 0.0)
            try:
                await _sdk_call(sport.StopMove)
            except Exception:
                pass
            await _broadcast_status()
            await _broadcast_log(f"client disconnected: {ra}", level="info")
            print(f"[go2_control_ws] client disconnected: {ra}")

    async def control_loop() -> None:
        loop_state: dict[str, Any] = {"last_kind": "none", "last_stop_ts": 0.0}
        while True:
            await asyncio.sleep(args.control_period)
            async with control_gate_lock:
                if time.monotonic() < float(control_gate["until_ts"]):
                    continue
            async with pilot_lock:
                p = pilot["ws"]
            if p is None:
                continue

            async with target_lock:
                vx = float(target["vx"])
                vy = float(target["vy"])
                vyaw = float(target["vyaw"])
                ts = float(target["ts"])

            now = time.monotonic()
            if now - ts > args.command_timeout:
                vx = 0.0
                vy = 0.0
                vyaw = 0.0

            try:
                if vx == 0.0 and vy == 0.0 and vyaw == 0.0:
                    # Avoid spamming StopMove on every loop tick when already idle.
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
                    await _broadcast_log(f"{op}: code={code} hint={_code_hint(code)}", level="warn")
            except Exception as exc:
                async with runtime_lock:
                    runtime["last_code"] = -2
                    runtime["last_op"] = "move_exception"
                    runtime["last_error"] = str(exc)
                await _broadcast_log(f"move loop exception: {exc}", level="warn")

    async def stats_loop() -> None:
        while True:
            await asyncio.sleep(1.0)
            await _broadcast_status()

    serve_kw: dict[str, Any] = {
        "ping_interval": args.ws_ping_interval if args.ws_ping_interval > 0 else None,
        "ping_timeout": args.ws_ping_timeout if args.ws_ping_timeout > 0 else None,
    }
    print(f"[go2_control_ws] ws://{args.host}:{args.port} iface={args.iface}")
    try:
        async with websockets.serve(handler, args.host, args.port, **serve_kw):
            await asyncio.gather(control_loop(), stats_loop())
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
    p.add_argument("--ws-ping-interval", type=float, default=30.0, help="WS ping interval (s), <=0 to disable")
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
