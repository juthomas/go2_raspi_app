#!/usr/bin/env python3
"""
Pont LiDAR Go2 (DDS PointCloud2) -> WebSocket JSON sur Raspberry Pi.

Programme indépendant du TUI : lance ce script en parallèle pour streamer le nuage 3D
vers une autre application sur la même machine (ws://127.0.0.1:PORT) ou sur le LAN.

Dépendances :
  pip install websockets cyclonedds
  + unitree_sdk2py (repo Unitree, install editable)

Exemple :
  python3 scripts/go2_lidar_ws_bridge.py --iface eth0 --port 8765

Client WebSocket : se connecter à ws://<ip-du-pi>:8765
Chaque message texte est un JSON avec type \"go2_pointcloud\", stamp, frame_id, points [[x,y,z],...].
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import struct
import threading
import time
from typing import Any


def _run_dds_thread(iface: str, topic: str, on_msg: Any, queue_len: int) -> None:
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
    from unitree_sdk2py.idl.sensor_msgs.msg.dds_ import PointCloud2_

    ChannelFactoryInitialize(0, iface)
    sub = ChannelSubscriber(topic, PointCloud2_)
    sub.Init(handler=on_msg, queueLen=queue_len)


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


async def _amain(args: argparse.Namespace) -> None:
    try:
        import websockets
    except ImportError as e:
        raise SystemExit("Installe websockets: pip install websockets") from e

    box: list[dict[str, Any] | None] = [None]
    count = {"n": 0}

    def on_lidar(msg: Any) -> None:
        try:
            packed = _pack_message(
                msg,
                max_points=args.max_points,
                stride=args.stride,
                include_raw_b64=args.include_raw_b64,
            )
            packed["recv_mono"] = time.time()
            box[0] = packed
            count["n"] += 1
        except Exception as exc:
            box[0] = {"type": "error", "msg": str(exc)}

    def dds_thread() -> None:
        try:
            _run_dds_thread(args.iface, args.topic, on_lidar, args.queue_len)
        except Exception as exc:
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
            await ws.send(
                json.dumps(
                    {
                        "type": "hello",
                        "topic": args.topic,
                        "iface": args.iface,
                    }
                )
            )
            async for _ in ws:
                pass
        finally:
            await unregister(ws)

    last_sent_t = 0.0

    async def broadcast_loop() -> None:
        nonlocal last_sent_t
        while True:
            await asyncio.sleep(args.broadcast_period)
            snap = box[0]
            if snap is None:
                continue
            if args.rate_hz > 0:
                now = time.monotonic()
                min_dt = 1.0 / max(args.rate_hz, 1e-6)
                if now - last_sent_t < min_dt:
                    continue
                last_sent_t = now
            text = json.dumps(snap)
            async with clients_lock:
                dead: list[Any] = []
                for c in clients:
                    try:
                        await c.send(text)
                    except Exception:
                        dead.append(c)
                for c in dead:
                    clients.discard(c)

    prev_n = 0

    async def stats() -> None:
        nonlocal prev_n
        while True:
            await asyncio.sleep(5.0)
            n = count["n"]
            async with clients_lock:
                nc = len(clients)
            print(f"[go2_lidar_ws] frames DDS: {n} (+{n - prev_n} / 5s), clients WS: {nc}")
            prev_n = n

    host = args.host
    port = args.port
    print(f"[go2_lidar_ws] ws://{host}:{port}  topic={args.topic} iface={args.iface}")

    # Autoriser les navigateurs ouverts sur un autre port (ex. :8080 vs :8765) — même host, origine différente
    serve_kw: dict[str, Any] = {"ping_interval": 20, "ping_timeout": 20}
    try:
        import inspect

        sig = inspect.signature(websockets.serve)
        if "origins" in sig.parameters:
            serve_kw["origins"] = None  # type: ignore[assignment]
    except Exception:
        pass

    async with websockets.serve(handler, host, port, **serve_kw):
        await asyncio.gather(broadcast_loop(), stats())


def main() -> None:
    p = argparse.ArgumentParser(description="Stream LiDAR PointCloud2 (Go2 DDS) vers WebSocket JSON")
    p.add_argument("--iface", required=True, help="Interface réseau (ex: eth0)")
    p.add_argument(
        "--topic",
        default="rt/utlidar/cloud",
        help="Topic DDS sensor_msgs/PointCloud2 (adapter si besoin, voir doc Unitree).",
    )
    p.add_argument("--host", default="0.0.0.0", help="Bind WebSocket")
    p.add_argument("--port", type=int, default=8765, help="Port WebSocket")
    p.add_argument("--max-points", type=int, default=4000, help="Max points xyz par message (0 = tous)")
    p.add_argument("--stride", type=int, default=2, help="Sous-échantillonnage (1 = tous les points comptés)")
    p.add_argument("--queue-len", type=int, default=2, help="File DDS (petit = frames récentes seulement)")
    p.add_argument("--broadcast-period", type=float, default=0.02, help="Période boucle envoi WS (s)")
    p.add_argument("--rate-hz", type=float, default=0.0, help="Limite envoi WS approx (0 = illimité)")
    p.add_argument("--include-raw-b64", action="store_true", help="Inclure data_b64 (nuage brut)")
    args = p.parse_args()
    asyncio.run(_amain(args))


if __name__ == "__main__":
    main()
