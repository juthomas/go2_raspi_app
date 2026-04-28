#!/usr/bin/env python3
"""
Simple GO2 control bridge (DDS sport RPC <-> WebSocket JSON).

WebSocket protocol:
  - server -> client:
      {"type":"hello","iface":"eth0"}
      {"type":"ack","cmd":"stand_up","ok":true}
      {"type":"status","pilot":true,"vx":0.2,"vy":0.0,"vyaw":0.0}
      {"type":"error","msg":"..."}
  - client -> server:
      {"type":"claim_pilot"}
      {"type":"release_pilot"}
      {"type":"stand_up"}
      {"type":"stand_down"}
      {"type":"stop"}
      {"type":"twist","vx":0.2,"vy":0.0,"vyaw":0.0}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any


def _code_hint(code: int) -> str:
    hints = {
        0: "OK",
        3102: "DDS send failed (check iface/cable).",
        3104: "RPC timeout.",
        3203: "API unsupported by firmware.",
        3204: "Invalid argument.",
        4202: "sport service not initialized.",
    }
    return hints.get(code, "Unknown SDK/robot error.")


async def _amain(args: argparse.Namespace) -> None:
    try:
        import websockets
        from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import MotionSwitcherClient
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize
        from unitree_sdk2py.go2.sport.sport_client import SportClient
    except ImportError as e:
        raise SystemExit(f"Missing dependency: {e}") from e

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

    def _ensure_normal_mode() -> tuple[bool, str | None]:
        check_code, payload = motion.CheckMode()
        if check_code == 0 and "normal" in str(payload).lower():
            return True, None
        select_code, _ = motion.SelectMode("normal")
        if select_code != 0:
            return False, f"SelectMode(normal) failed: code={select_code}, hint={_code_hint(select_code)}"
        return True, None

    async def handler(ws: Any) -> None:
        ra = getattr(ws, "remote_address", "?")
        print(f"[go2_control_ws] client connected: {ra}")
        async with clients_lock:
            clients.add(ws)
        await _send_json(ws, {"type": "hello", "iface": args.iface})

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
                if typ == "claim_pilot":
                    async with pilot_lock:
                        pilot["ws"] = ws
                    ok_mode, mode_msg = _ensure_normal_mode()
                    if ok_mode:
                        await _ack(ws, "claim_pilot", True, "pilot granted")
                    else:
                        await _ack(ws, "claim_pilot", False, mode_msg)
                    await _broadcast_status()
                    continue
                if typ == "release_pilot":
                    async with pilot_lock:
                        if pilot["ws"] is ws:
                            pilot["ws"] = None
                    await set_target(0.0, 0.0, 0.0)
                    await _ack(ws, "release_pilot", True)
                    await _broadcast_status()
                    continue

                async with pilot_lock:
                    is_pilot = pilot["ws"] is ws
                if not is_pilot:
                    await _ack(ws, str(typ), False, "not pilot")
                    continue

                if typ == "stand_up":
                    ok_mode, mode_msg = _ensure_normal_mode()
                    if not ok_mode:
                        await _ack(ws, "stand_up", False, mode_msg)
                        async with runtime_lock:
                            runtime["last_code"] = -1
                            runtime["last_op"] = "stand_up"
                            runtime["last_error"] = mode_msg or "ensure_normal_mode failed"
                        await _broadcast_status()
                        continue
                    code = int(sport.StandUp())
                    async with runtime_lock:
                        runtime["last_code"] = code
                        runtime["last_op"] = "stand_up"
                        runtime["last_error"] = "" if code == 0 else _code_hint(code)
                    await _ack(ws, "stand_up", code == 0, f"code={code}, hint={_code_hint(code)}")
                    await _broadcast_status()
                elif typ == "stand_down":
                    ok_mode, mode_msg = _ensure_normal_mode()
                    if not ok_mode:
                        await _ack(ws, "stand_down", False, mode_msg)
                        async with runtime_lock:
                            runtime["last_code"] = -1
                            runtime["last_op"] = "stand_down"
                            runtime["last_error"] = mode_msg or "ensure_normal_mode failed"
                        await _broadcast_status()
                        continue
                    code = int(sport.StandDown())
                    async with runtime_lock:
                        runtime["last_code"] = code
                        runtime["last_op"] = "stand_down"
                        runtime["last_error"] = "" if code == 0 else _code_hint(code)
                    await _ack(ws, "stand_down", code == 0, f"code={code}, hint={_code_hint(code)}")
                    await _broadcast_status()
                elif typ == "stop":
                    await set_target(0.0, 0.0, 0.0)
                    code = int(sport.StopMove())
                    async with runtime_lock:
                        runtime["last_code"] = code
                        runtime["last_op"] = "stop"
                        runtime["last_error"] = "" if code == 0 else _code_hint(code)
                    await _ack(ws, "stop", code == 0, f"code={code}, hint={_code_hint(code)}")
                    await _broadcast_status()
                elif typ == "twist":
                    vx = float(data.get("vx", 0.0))
                    vy = float(data.get("vy", 0.0))
                    vyaw = float(data.get("vyaw", 0.0))
                    vx = max(-args.max_vx, min(args.max_vx, vx))
                    vy = max(-args.max_vy, min(args.max_vy, vy))
                    vyaw = max(-args.max_vyaw, min(args.max_vyaw, vyaw))
                    await set_target(vx, vy, vyaw)
                    await _ack(ws, "twist", True, f"target=({vx:+.2f},{vy:+.2f},{vyaw:+.2f})")
                else:
                    await _send_json(ws, {"type": "error", "msg": f"unknown type: {typ}"})
        finally:
            async with clients_lock:
                clients.discard(ws)
            async with pilot_lock:
                if pilot["ws"] is ws:
                    pilot["ws"] = None
            await set_target(0.0, 0.0, 0.0)
            try:
                sport.StopMove()
            except Exception:
                pass
            await _broadcast_status()
            print(f"[go2_control_ws] client disconnected: {ra}")

    async def control_loop() -> None:
        while True:
            await asyncio.sleep(args.control_period)
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
                    code = int(sport.StopMove())
                    async with runtime_lock:
                        runtime["last_code"] = code
                        runtime["last_op"] = "stop_move_loop"
                        runtime["last_move_ts"] = time.monotonic()
                        runtime["last_error"] = "" if code == 0 else _code_hint(code)
                else:
                    code = int(sport.Move(vx, vy, vyaw))
                    async with runtime_lock:
                        runtime["last_code"] = code
                        runtime["last_op"] = "move_loop"
                        runtime["last_move_ts"] = time.monotonic()
                        runtime["last_error"] = "" if code == 0 else _code_hint(code)
            except Exception as exc:
                async with runtime_lock:
                    runtime["last_code"] = -2
                    runtime["last_op"] = "move_exception"
                    runtime["last_error"] = str(exc)

    async def stats_loop() -> None:
        while True:
            await asyncio.sleep(1.0)
            await _broadcast_status()
            async with clients_lock:
                n_clients = len(clients)
            async with pilot_lock:
                has_pilot = pilot["ws"] is not None
            async with target_lock:
                vx = target["vx"]
                vy = target["vy"]
                vyaw = target["vyaw"]
            async with runtime_lock:
                last_code = runtime["last_code"]
                last_op = runtime["last_op"]
                last_error = runtime["last_error"]
            print(
                f"[go2_control_ws] clients={n_clients} pilot={int(has_pilot)} "
                f"target=({vx:+.2f},{vy:+.2f},{vyaw:+.2f}) "
                f"last={last_op}:{last_code} err={last_error!r}"
            )

    serve_kw: dict[str, Any] = {
        "ping_interval": args.ws_ping_interval if args.ws_ping_interval > 0 else None,
        "ping_timeout": args.ws_ping_timeout if args.ws_ping_timeout > 0 else None,
    }
    print(f"[go2_control_ws] ws://{args.host}:{args.port} iface={args.iface}")
    async with websockets.serve(handler, args.host, args.port, **serve_kw):
        await asyncio.gather(control_loop(), stats_loop())


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
    p.add_argument("--ws-ping-interval", type=float, default=30.0, help="WS ping interval (s), <=0 to disable")
    p.add_argument("--ws-ping-timeout", type=float, default=60.0, help="WS ping timeout (s), <=0 to disable")
    args = p.parse_args()
    asyncio.run(_amain(args))


if __name__ == "__main__":
    main()
