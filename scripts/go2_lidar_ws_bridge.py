#!/usr/bin/env python3
"""
Pont LiDAR Go2 (DDS PointCloud2) -> WebSocket JSON sur Raspberry Pi.

Programme indépendant du TUI : lance ce script en parallèle pour streamer le nuage 3D
vers une autre application sur la même machine (ws://127.0.0.1:PORT) ou sur le LAN.

Dépendances :
  pip install websockets cyclonedds
  + unitree_sdk2py (repo Unitree, install editable)
  + lz4 (optionnel, pour --voxel-decompress)

Exemple :
  python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765
  python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --voxel --include-joints
  python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --voxel --voxel-map-source compressed --voxel-decompress

Client WebSocket : se connecter à ws://<ip-du-pi>:8765
Messages JSON : go2_pointcloud, go2_voxel_map (si --voxel), hello, pong.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))
import asyncio
import base64
import json
import math
import struct
import threading
import time
from typing import Any

_DEBUG_LOG_PATH = "/home/pigeons/Documents/unitree/go2_raspi_app/.cursor/debug-9466d0.log"
_DEBUG_SESSION = "9466d0"


def _debug_log(hypothesis_id: str, location: str, message: str, data: dict[str, Any] | None = None) -> None:
    # #region agent log
    try:
        payload = {
            "sessionId": _DEBUG_SESSION,
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data or {},
            "timestamp": int(time.time() * 1000),
        }
        with open(_DEBUG_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=True) + "\n")
    except Exception:
        pass
    # #endregion


def _run_dds_thread(
    iface: str,
    *,
    lidar_topic: str,
    queue_len: int,
    on_lidar: Any,
    on_sport: Any,
    on_low: Any,
    sport_topic: str,
    low_topic: str,
    on_voxel: Any | None = None,
    voxel_topic: str | None = None,
    on_height_map: Any | None = None,
    height_map_topic: str | None = None,
) -> None:
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
    from unitree_sdk2py.idl.unitree_go.msg.dds_ import HeightMap_, LowState_, SportModeState_
    from unitree_sdk2py.idl.sensor_msgs.msg.dds_ import PointCloud2_

    ChannelFactoryInitialize(0, iface)
    sub_lidar = ChannelSubscriber(lidar_topic, PointCloud2_)
    sub_lidar.Init(handler=on_lidar, queueLen=queue_len)

    sub_sport = ChannelSubscriber(sport_topic, SportModeState_)
    sub_sport.Init(handler=on_sport, queueLen=queue_len)

    sub_low = ChannelSubscriber(low_topic, LowState_)
    sub_low.Init(handler=on_low, queueLen=queue_len)

    _subs: list[Any] = [sub_lidar, sub_sport, sub_low]
    if on_voxel is not None and voxel_topic:
        from _voxel_idl import load_voxel_map_compressed_type

        VoxelMapCompressed_ = load_voxel_map_compressed_type()

        # #region agent log
        _debug_log(
            "A",
            "go2_lidar_ws_bridge.py:_run_dds_thread",
            "voxel subscriber init",
            {
                "voxel_topic": voxel_topic,
                "message_type": "VoxelMapCompressed_",
                "topic_looks_compressed": voxel_topic.endswith("_compressed"),
            },
        )
        # #endregion
        sub_voxel = ChannelSubscriber(voxel_topic, VoxelMapCompressed_)
        sub_voxel.Init(handler=on_voxel, queueLen=queue_len)
        _subs.append(sub_voxel)
        # #region agent log
        _debug_log(
            "C",
            "go2_lidar_ws_bridge.py:_run_dds_thread",
            "voxel subscriber init ok",
            {"voxel_topic": voxel_topic, "queue_len": queue_len},
        )
        # #endregion

    if on_height_map is not None and height_map_topic:
        sub_height = ChannelSubscriber(height_map_topic, HeightMap_)
        sub_height.Init(handler=on_height_map, queueLen=queue_len)
        _subs.append(sub_height)

    while True:
        time.sleep(3600.0)


def _field_name(f: Any) -> str:
    n = getattr(f, "name", "") or ""
    if isinstance(n, bytes):
        n = n.decode("utf-8", errors="ignore")
    return n.split("\x00", 1)[0].strip()


def _decode_xyz_points(msg: Any, max_points: int, stride: int) -> tuple[list[list[float]], str | None]:
    try:
        raw = bytes(msg.data)
    except Exception as e:
        return [], f"data bytes: {e}"
    if not raw:
        return [], "empty data"

    w = int(msg.width) * int(msg.height)
    ps = int(msg.point_step)
    if ps <= 0 or w <= 0:
        return [], f"bad width/height/step={msg.width} {msg.height} {msg.point_step}"

    off: dict[str, int] = {}
    for f in msg.fields:
        nm = _field_name(f)
        if nm:
            off[nm] = int(f.offset)

    for key in ("x", "y", "z"):
        if key not in off:
            return [], f"missing field {key} in {[ _field_name(f) for f in msg.fields ]}"

    out: list[list[float]] = []
    step = max(1, int(stride))
    cap = w if max_points <= 0 else min(w, max_points * step)
    for i in range(0, min(w, cap), step):
        base = i * ps
        if base + 12 > len(raw):
            break
        try:
            x = struct.unpack_from("<f", raw, base + off["x"])[0]
            y = struct.unpack_from("<f", raw, base + off["y"])[0]
            z = struct.unpack_from("<f", raw, base + off["z"])[0]
        except struct.error:
            continue
        if not math.isfinite(x) or not math.isfinite(y) or not math.isfinite(z):
            continue
        out.append([float(x), float(y), float(z)])
        if max_points > 0 and len(out) >= max_points:
            break
    return out, None


def _pack_message(
    msg: Any,
    *,
    max_points: int,
    stride: int,
    include_raw_b64: bool,
) -> dict[str, Any]:
    stamp = getattr(msg.header, "stamp", None)
    sec = int(getattr(stamp, "sec", 0)) if stamp is not None else 0
    nsec = int(getattr(stamp, "nanosec", 0)) if stamp is not None else 0
    frame_id = getattr(msg.header, "frame_id", "") or ""
    if isinstance(frame_id, bytes):
        frame_id = frame_id.decode("utf-8", errors="ignore").split("\x00", 1)[0]

    pts, err = _decode_xyz_points(msg, max_points=max_points, stride=stride)
    payload: dict[str, Any] = {
        "type": "go2_pointcloud",
        "stamp": {"sec": sec, "nanosec": nsec},
        "frame_id": frame_id,
        "width": int(msg.width),
        "height": int(msg.height),
        "point_step": int(msg.point_step),
        "is_dense": bool(msg.is_dense),
        "points": pts,
        "decode_note": err,
    }
    if include_raw_b64 or not pts:
        try:
            payload["data_b64"] = base64.b64encode(bytes(msg.data)).decode("ascii")
        except Exception:
            payload["data_b64"] = ""
    return payload


def _decode_voxel_frame_id(msg: Any) -> str:
    frame_id = getattr(msg, "frame_id", "") or ""
    if isinstance(frame_id, bytes):
        frame_id = frame_id.decode("utf-8", errors="ignore")
    return str(frame_id).split("\x00", 1)[0].strip()


def _extract_occupied_points(
    raw: bytes,
    *,
    origin: list[float],
    width: list[int],
    resolution: float,
    max_points: int,
) -> tuple[list[list[float]], str | None]:
    nx, ny, nz = (max(0, int(v)) for v in width)
    expected = nx * ny * nz
    if expected <= 0:
        return [], "invalid width dimensions"
    if len(raw) < expected:
        return [], f"raw size {len(raw)} < expected {expected}"

    res = float(resolution)
    if not math.isfinite(res) or res <= 0:
        return [], f"invalid resolution={resolution}"

    ox, oy, oz = (float(origin[i]) if i < len(origin) else 0.0 for i in range(3))
    cap = max_points if max_points > 0 else expected
    out: list[list[float]] = []
    idx = 0
    for iz in range(nz):
        for iy in range(ny):
            for ix in range(nx):
                if raw[idx] == 0:
                    idx += 1
                    continue
                out.append([ox + ix * res, oy + iy * res, oz + iz * res])
                idx += 1
                if len(out) >= cap:
                    return out, None
    return out, None


_HEIGHT_MAP_EMPTY_Z = 1_000_000_000.0


def _is_valid_height_map_z(z: float) -> bool:
    if not math.isfinite(z) or abs(z) < 1e-6:
        return False
    # Unitree uses 1e9 as unknown/empty cell marker.
    if abs(z - _HEIGHT_MAP_EMPTY_Z) < 1.0 or z >= 1e6:
        return False
    return True


def _extract_height_map_points(
    msg: Any,
    *,
    max_points: int,
) -> tuple[list[list[float]], str | None]:
    grid_w = int(msg.width)
    grid_h = int(msg.height)
    if grid_w <= 0 or grid_h <= 0:
        return [], "invalid width/height"

    res = float(msg.resolution)
    if not math.isfinite(res) or res <= 0:
        return [], f"invalid resolution={msg.resolution}"

    ox = float(msg.origin[0]) if len(msg.origin) > 0 else 0.0
    oy = float(msg.origin[1]) if len(msg.origin) > 1 else 0.0
    try:
        data = [float(v) for v in msg.data]
    except Exception as exc:
        return [], f"height data: {exc}"

    candidates: list[list[float]] = []
    for iy in range(grid_h):
        for ix in range(grid_w):
            idx = grid_w * iy + ix
            if idx >= len(data):
                break
            z = data[idx]
            if not _is_valid_height_map_z(z):
                continue
            candidates.append([ox + ix * res, oy + iy * res, z])

    if max_points > 0 and len(candidates) > max_points:
        step = max(1, len(candidates) // max_points)
        candidates = candidates[::step][:max_points]
    return candidates, None


def _pack_height_map_message(
    msg: Any,
    *,
    max_points: int,
    height_map_topic: str,
) -> dict[str, Any]:
    frame_id = _decode_voxel_frame_id(msg)
    grid_w = int(msg.width)
    grid_h = int(msg.height)
    resolution = float(msg.resolution)
    ox = float(msg.origin[0]) if len(msg.origin) > 0 else 0.0
    oy = float(msg.origin[1]) if len(msg.origin) > 1 else 0.0

    pts, err = _extract_height_map_points(msg, max_points=max_points)
    payload: dict[str, Any] = {
        "type": "go2_voxel_map",
        "map_source": "height_map",
        "height_map_topic": height_map_topic,
        "stamp": float(msg.stamp),
        "frame_id": frame_id,
        "resolution": resolution,
        "origin": [ox, oy, 0.0],
        "width": [grid_w, grid_h, 1],
        "decode_note": err,
    }
    if pts:
        payload["occupied_points"] = pts
    return payload


def _pack_voxel_message(
    msg: Any,
    *,
    decompress: bool,
    max_points: int,
) -> dict[str, Any]:
    frame_id = _decode_voxel_frame_id(msg)
    origin = [float(v) for v in msg.origin]
    width = [int(v) for v in msg.width]
    resolution = float(msg.resolution)
    src_size = int(msg.src_size)

    try:
        compressed = bytes(msg.data)
    except Exception as exc:
        compressed = b""

    payload: dict[str, Any] = {
        "type": "go2_voxel_map",
        "map_source": "compressed",
        "stamp": float(msg.stamp),
        "frame_id": frame_id,
        "resolution": resolution,
        "origin": origin,
        "width": width,
        "src_size": src_size,
        "compressed_size": len(compressed),
        "data_b64": base64.b64encode(compressed).decode("ascii") if compressed else "",
        "decode_note": None,
    }

    if not decompress:
        return payload

    if not compressed:
        payload["decode_note"] = "empty compressed data"
        return payload
    if src_size <= 0:
        payload["decode_note"] = "invalid src_size"
        return payload

    try:
        import lz4.block
    except ImportError:
        payload["decode_note"] = "lz4 not installed (pip install lz4)"
        return payload

    try:
        raw = lz4.block.decompress(compressed, uncompressed_size=src_size)
    except Exception as exc:
        payload["decode_note"] = f"lz4 decompress: {exc}"
        return payload

    pts, err = _extract_occupied_points(
        raw,
        origin=origin,
        width=width,
        resolution=resolution,
        max_points=max_points,
    )
    if err:
        payload["decode_note"] = err
    else:
        payload["occupied_points"] = pts
    return payload


def _extract_sport_state(msg: Any) -> dict[str, Any]:
    return {
        "mode": int(msg.mode),
        "gait_type": int(msg.gait_type),
        "position": [float(v) for v in msg.position],
        "velocity": [float(v) for v in msg.velocity],
        "yaw_speed": float(msg.yaw_speed),
        "rpy": [float(v) for v in msg.imu_state.rpy],
    }


def _extract_low_state(msg: Any, include_joints: bool) -> dict[str, Any]:
    data: dict[str, Any] = {
        "battery_soc": int(msg.bms_state.soc),
        "power_v": float(msg.power_v),
        "power_a": float(msg.power_a),
        "foot_force": [int(v) for v in msg.foot_force],
    }
    if include_joints:
        n = min(20, len(msg.motor_state))
        data["joint_q"] = [float(msg.motor_state[i].q) for i in range(n)]
        data["joint_dq"] = [float(msg.motor_state[i].dq) for i in range(n)]
    return data


def _build_robot_state_snapshot(state: dict[str, Any]) -> dict[str, Any] | None:
    sport = state.get("sport")
    low = state.get("low")
    sport_mono = state.get("sport_mono")
    low_mono = state.get("low_mono")
    if sport is None and low is None:
        return None

    now = time.monotonic()
    out: dict[str, Any] = {}
    if sport is not None:
        out.update(sport)
        if isinstance(sport_mono, float):
            out["sport_age_s"] = max(0.0, now - sport_mono)
    if low is not None:
        out.update(low)
        if isinstance(low_mono, float):
            out["low_age_s"] = max(0.0, now - low_mono)
    return out


async def _broadcast_json(clients: set[Any], clients_lock: asyncio.Lock, text: str) -> None:
    async with clients_lock:
        dead: list[Any] = []
        for c in clients:
            try:
                await c.send(text)
            except Exception:
                dead.append(c)
        for c in dead:
            clients.discard(c)


async def _amain(args: argparse.Namespace) -> None:
    try:
        import websockets
        from websockets.exceptions import ConnectionClosed
    except ImportError as e:
        raise SystemExit("Installe websockets: pip install websockets") from e

    box: list[dict[str, Any] | None] = [None]
    count = {"n": 0}
    voxel_box: list[dict[str, Any] | None] = [None]
    voxel_count = {"n": 0}
    height_map_count = {"n": 0}
    compressed_map_count = {"n": 0}
    use_height_map = args.voxel and args.voxel_map_source in ("height_map", "both")
    use_compressed = args.voxel and args.voxel_map_source in ("compressed", "both")
    state_lock = threading.Lock()
    robot_state: dict[str, Any] = {
        "sport": None,
        "low": None,
        "sport_mono": None,
        "low_mono": None,
    }

    def on_lidar(msg: Any) -> None:
        try:
            packed = _pack_message(
                msg,
                max_points=args.max_points,
                stride=args.stride,
                include_raw_b64=args.include_raw_b64,
            )
            packed["recv_mono"] = time.time()
            with state_lock:
                snap = _build_robot_state_snapshot(robot_state)
            if snap is not None:
                packed["robot_state"] = snap
            box[0] = packed
            count["n"] += 1
        except Exception as exc:
            box[0] = {"type": "error", "msg": str(exc)}

    def on_voxel(msg: Any) -> None:
        try:
            # #region agent log
            _debug_log(
                "B",
                "go2_lidar_ws_bridge.py:on_voxel",
                "voxel dds callback",
                {
                    "stamp": float(getattr(msg, "stamp", 0.0)),
                    "compressed_size": len(bytes(getattr(msg, "data", b"") or b"")),
                    "src_size": int(getattr(msg, "src_size", 0)),
                },
            )
            # #endregion
            packed = _pack_voxel_message(
                msg,
                decompress=args.voxel_decompress,
                max_points=args.voxel_max_points,
            )
            packed["recv_mono"] = time.time()
            with state_lock:
                snap = _build_robot_state_snapshot(robot_state)
            if snap is not None:
                packed["robot_state"] = snap
            voxel_box[0] = packed
            voxel_count["n"] += 1
            compressed_map_count["n"] += 1
        except Exception as exc:
            # #region agent log
            _debug_log(
                "D",
                "go2_lidar_ws_bridge.py:on_voxel",
                "voxel pack failed",
                {"error": str(exc)},
            )
            # #endregion
            voxel_box[0] = {"type": "error", "msg": f"voxel: {exc}"}

    def on_height_map(msg: Any) -> None:
        try:
            packed = _pack_height_map_message(
                msg,
                max_points=args.voxel_max_points,
                height_map_topic=args.height_map_topic,
            )
            packed["recv_mono"] = time.time()
            with state_lock:
                snap = _build_robot_state_snapshot(robot_state)
            if snap is not None:
                packed["robot_state"] = snap
            voxel_box[0] = packed
            voxel_count["n"] += 1
            height_map_count["n"] += 1
        except Exception as exc:
            voxel_box[0] = {"type": "error", "msg": f"height_map: {exc}"}

    def on_sport(msg: Any) -> None:
        try:
            data = _extract_sport_state(msg)
            with state_lock:
                robot_state["sport"] = data
                robot_state["sport_mono"] = time.monotonic()
        except Exception:
            pass

    def on_low(msg: Any) -> None:
        try:
            data = _extract_low_state(msg, include_joints=args.include_joints)
            with state_lock:
                robot_state["low"] = data
                robot_state["low_mono"] = time.monotonic()
        except Exception:
            pass

    def dds_thread() -> None:
        try:
            _run_dds_thread(
                args.iface,
                lidar_topic=args.topic,
                queue_len=args.queue_len,
                on_lidar=on_lidar,
                on_sport=on_sport,
                on_low=on_low,
                sport_topic=args.sport_topic,
                low_topic=args.low_topic,
                on_voxel=on_voxel if use_compressed else None,
                voxel_topic=args.voxel_topic if use_compressed else None,
                on_height_map=on_height_map if use_height_map else None,
                height_map_topic=args.height_map_topic if use_height_map else None,
            )
        except Exception as exc:
            # #region agent log
            _debug_log(
                "C",
                "go2_lidar_ws_bridge.py:dds_thread",
                "dds thread failed",
                {"error": str(exc)},
            )
            # #endregion
            box[0] = {"type": "error", "msg": f"DDS init/subscribe: {exc}"}

    threading.Thread(target=dds_thread, name="dds-lidar", daemon=True).start()

    clients: set[Any] = set()
    clients_lock = asyncio.Lock()

    async def register(ws: Any) -> None:
        async with clients_lock:
            clients.add(ws)

    async def unregister(ws: Any) -> None:
        async with clients_lock:
            clients.discard(ws)

    async def handler(ws: Any) -> None:
        try:
            ra = getattr(ws, "remote_address", "?")
        except Exception:
            ra = "?"
        print(f"[go2_lidar_ws] client connecte: {ra}")
        await register(ws)
        try:
            hello: dict[str, Any] = {
                "type": "hello",
                "topic": args.topic,
                "sport_topic": args.sport_topic,
                "low_topic": args.low_topic,
                "iface": args.iface,
            }
            if args.voxel:
                hello["voxel_enabled"] = True
                hello["voxel_map_source"] = args.voxel_map_source
                if use_height_map:
                    hello["height_map_topic"] = args.height_map_topic
                if use_compressed:
                    hello["voxel_topic"] = args.voxel_topic
            await ws.send(json.dumps(hello))
            async for raw in ws:
                try:
                    data = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(data, dict):
                    continue
                if data.get("type") == "ping":
                    await ws.send(
                        json.dumps(
                            {
                                "type": "pong",
                                "seq": data.get("seq"),
                                "client_ts_ms": data.get("client_ts_ms"),
                                "server_ts": time.time(),
                            }
                        )
                    )
        except ConnectionClosed as exc:
            print(f"[go2_lidar_ws] client deconnecte ({ra}): code={exc.code} reason={exc.reason!r}")
        finally:
            await unregister(ws)

    last_sent_t = 0.0
    last_broadcast_n = 0

    async def broadcast_loop() -> None:
        nonlocal last_sent_t, last_broadcast_n
        while True:
            await asyncio.sleep(args.broadcast_period)
            snap = box[0]
            if snap is None:
                continue
            current_n = count["n"]
            if current_n <= last_broadcast_n:
                continue
            if args.rate_hz > 0:
                now = time.monotonic()
                min_dt = 1.0 / max(args.rate_hz, 1e-6)
                if now - last_sent_t < min_dt:
                    continue
                last_sent_t = now
            await _broadcast_json(clients, clients_lock, json.dumps(snap))
            last_broadcast_n = current_n

    last_voxel_sent_t = 0.0
    last_voxel_broadcast_n = 0
    last_voxel_stamp: float | None = None

    async def voxel_broadcast_loop() -> None:
        nonlocal last_voxel_sent_t, last_voxel_broadcast_n, last_voxel_stamp
        period = 1.0 / max(args.voxel_rate_hz, 1e-6)
        while True:
            await asyncio.sleep(period)
            snap = voxel_box[0]
            if snap is None:
                continue
            current_n = voxel_count["n"]
            if current_n <= last_voxel_broadcast_n:
                continue
            stamp = snap.get("stamp")
            if isinstance(stamp, (int, float)) and last_voxel_stamp == float(stamp):
                last_voxel_broadcast_n = current_n
                continue
            now = time.monotonic()
            min_dt = 1.0 / max(args.voxel_rate_hz, 1e-6)
            if now - last_voxel_sent_t < min_dt:
                continue
            last_voxel_sent_t = now
            await _broadcast_json(clients, clients_lock, json.dumps(snap))
            last_voxel_broadcast_n = current_n
            if isinstance(stamp, (int, float)):
                last_voxel_stamp = float(stamp)

    prev_n = 0
    prev_voxel_n = 0
    prev_height_map_n = 0
    prev_compressed_map_n = 0
    voxel_started_at = time.monotonic()
    voxel_warned = False

    async def stats() -> None:
        nonlocal prev_n, prev_voxel_n, prev_height_map_n, prev_compressed_map_n, voxel_warned
        while True:
            await asyncio.sleep(5.0)
            n = count["n"]
            vn = voxel_count["n"]
            hn = height_map_count["n"]
            cn = compressed_map_count["n"]
            async with clients_lock:
                nc = len(clients)
            line = f"[go2_lidar_ws] frames DDS: {n} (+{n - prev_n} / 5s), clients WS: {nc}"
            if args.voxel:
                if use_height_map:
                    line += f", map DDS (height_map): {hn} (+{hn - prev_height_map_n} / 5s)"
                if use_compressed:
                    line += f", map DDS (compressed): {cn} (+{cn - prev_compressed_map_n} / 5s)"
                elif not use_height_map:
                    line += f", map DDS: {vn} (+{vn - prev_voxel_n} / 5s)"
            print(line)
            if use_height_map and use_compressed:
                no_map_frames = hn == 0 and cn == 0
            elif use_height_map:
                no_map_frames = hn == 0
            else:
                no_map_frames = cn == 0
            if (
                args.voxel
                and not voxel_warned
                and no_map_frames
                and time.monotonic() - voxel_started_at >= 10.0
            ):
                voxel_warned = True
                if use_height_map:
                    print(
                        "[go2_lidar_ws] WARN: aucune frame height_map — le robot ne publie pas la carte (LiDAR OK). "
                        "1) Unitree app: Function → 3D LiDAR Mapping → démarrer l'enregistrement (pas seulement créer la map). "
                        "2) Bouger le robot 10–20 s. "
                        f"3) Tester: ./scripts/go2_voxel_probe.sh  Topic: {args.height_map_topic}"
                    )
                else:
                    print(
                        f"[go2_lidar_ws] WARN: aucune frame voxel sur {args.voxel_topic} — "
                        "essayer --voxel-map-source height_map si le mapping app Unitree est actif. "
                        "Tester: ./scripts/go2_voxel_probe.sh MAP_SOURCE=compressed"
                    )
                # #region agent log
                _debug_log(
                    "B",
                    "go2_lidar_ws_bridge.py:stats",
                    "no map frames after 10s",
                    {
                        "voxel_map_source": args.voxel_map_source,
                        "height_map_topic": args.height_map_topic,
                        "voxel_topic": args.voxel_topic,
                        "lidar_frames": n,
                        "ws_clients": nc,
                    },
                )
                # #endregion
            prev_n = n
            prev_voxel_n = vn
            prev_height_map_n = hn
            prev_compressed_map_n = cn

    host = args.host
    port = args.port
    map_note = ""
    if args.voxel:
        if use_height_map:
            map_note += f" height_map={args.height_map_topic}"
        if use_compressed:
            map_note += f" voxel={args.voxel_topic}"
    print(f"[go2_lidar_ws] ws://{host}:{port}  topic={args.topic}{map_note} iface={args.iface}")
    if use_compressed and not args.voxel_topic.endswith("_compressed"):
        print(
            f"[go2_lidar_ws] WARN: --voxel-topic={args.voxel_topic} n'est pas un topic "
            "VoxelMapCompressed (attendu: rt/utlidar/voxel_map_compressed)"
        )
        # #region agent log
        _debug_log(
            "A",
            "go2_lidar_ws_bridge.py:_amain",
            "voxel topic type mismatch warning",
            {"voxel_topic": args.voxel_topic},
        )
        # #endregion

    ping_interval: float | None = args.ws_ping_interval if args.ws_ping_interval > 0 else None
    ping_timeout: float | None = args.ws_ping_timeout if args.ws_ping_timeout > 0 else None
    serve_kw: dict[str, Any] = {"ping_interval": ping_interval, "ping_timeout": ping_timeout}
    try:
        import inspect

        sig = inspect.signature(websockets.serve)
        if "origins" in sig.parameters:
            serve_kw["origins"] = None  # type: ignore[assignment]
    except Exception:
        pass

    loops: list[Any] = [broadcast_loop(), stats()]
    if args.voxel:
        loops.append(voxel_broadcast_loop())

    async with websockets.serve(handler, host, port, **serve_kw):
        await asyncio.gather(*loops)


def main() -> None:
    p = argparse.ArgumentParser(description="Stream LiDAR PointCloud2 (Go2 DDS) vers WebSocket JSON")
    p.add_argument("--iface", required=True, help="Interface réseau (ex: eth0)")
    p.add_argument(
        "--topic",
        default="rt/utlidar/cloud",
        help="Topic DDS sensor_msgs/PointCloud2 (adapter si besoin, voir doc Unitree).",
    )
    p.add_argument(
        "--sport-topic",
        default="rt/sportmodestate",
        help="Topic DDS SportModeState (position/vitesse/attitude).",
    )
    p.add_argument(
        "--low-topic",
        default="rt/lowstate",
        help="Topic DDS LowState (batterie/joints).",
    )
    p.add_argument("--host", default="0.0.0.0", help="Bind WebSocket")
    p.add_argument("--port", type=int, default=8765, help="Port WebSocket")
    p.add_argument("--max-points", type=int, default=4000, help="Max points xyz par message (0 = tous)")
    p.add_argument("--stride", type=int, default=2, help="Sous-échantillonnage (1 = tous les points comptés)")
    p.add_argument("--queue-len", type=int, default=2, help="File DDS (petit = frames récentes seulement)")
    p.add_argument("--broadcast-period", type=float, default=0.02, help="Période boucle envoi WS (s)")
    p.add_argument("--rate-hz", type=float, default=0.0, help="Limite envoi WS approx (0 = illimité)")
    p.add_argument(
        "--ws-ping-interval",
        type=float,
        default=30.0,
        help="Ping keepalive WS (s). <=0 pour desactiver.",
    )
    p.add_argument(
        "--ws-ping-timeout",
        type=float,
        default=60.0,
        help="Timeout keepalive WS (s). <=0 pour desactiver.",
    )
    p.add_argument("--include-raw-b64", action="store_true", help="Inclure data_b64 (nuage brut)")
    p.add_argument(
        "--include-joints",
        action="store_true",
        help="Inclure joint_q/joint_dq (orientation articulations) dans robot_state.",
    )
    p.add_argument(
        "--voxel",
        action="store_true",
        help="Diffuser go2_voxel_map sur le meme WS (source par defaut: height_map).",
    )
    p.add_argument(
        "--voxel-map-source",
        choices=("height_map", "compressed", "both"),
        default="height_map",
        help="Source carte: height_map (app Unitree), compressed (voxel_map_compressed), both.",
    )
    p.add_argument(
        "--height-map-topic",
        default="rt/utlidar/height_map_array",
        help="Topic DDS HeightMap (mapping app Unitree).",
    )
    p.add_argument(
        "--voxel-topic",
        default="rt/utlidar/voxel_map_compressed",
        help="Topic DDS VoxelMapCompressed (certains firmwares EDU).",
    )
    p.add_argument(
        "--voxel-rate-hz",
        type=float,
        default=1.0,
        help="Limite envoi WS pour go2_voxel_map (Hz).",
    )
    p.add_argument(
        "--voxel-decompress",
        action="store_true",
        help="Decompresse LZ4 cote Pi et inclut occupied_points (pip install lz4).",
    )
    p.add_argument(
        "--voxel-max-points",
        type=int,
        default=30000,
        help="Max occupied_points par message voxel (0 = tous).",
    )
    args = p.parse_args()
    asyncio.run(_amain(args))


if __name__ == "__main__":
    main()
