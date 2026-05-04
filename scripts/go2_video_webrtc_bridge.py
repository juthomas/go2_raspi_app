#!/usr/bin/env python3
"""
Go2 front camera -> WebRTC bridge.

- Captures JPEG samples from Unitree VideoClient over DDS/RPC.
- Exposes a tiny HTTP signaling API for browser peers.
- Streams one video track per peer via aiortc.

Signaling API:
- GET  /health
- POST /offer   body: {"sdp": "...", "type": "offer"}
                reply: {"sdp": "...", "type": "answer"}
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import threading
import time
from typing import Any

import numpy as np
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.contrib.media import MediaRelay
from av import VideoFrame


class SharedFrameBuffer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._frame_bgr: np.ndarray | None = None
        self._stamp = 0.0

    def set(self, frame_bgr: np.ndarray) -> None:
        with self._lock:
            self._frame_bgr = frame_bgr
            self._stamp = time.monotonic()

    def get(self) -> tuple[np.ndarray | None, float]:
        with self._lock:
            return self._frame_bgr, self._stamp


def _run_capture_thread(iface: str, fps: float, out: SharedFrameBuffer, stop_evt: threading.Event) -> None:
    import cv2
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize
    from unitree_sdk2py.go2.video.video_client import VideoClient

    ChannelFactoryInitialize(0, iface)
    client = VideoClient()
    client.SetTimeout(3.0)
    client.Init()

    min_dt = 1.0 / max(1.0, fps)
    next_t = time.monotonic()
    while not stop_evt.is_set():
        now = time.monotonic()
        if now < next_t:
            time.sleep(min(0.01, next_t - now))
            continue
        next_t = now + min_dt

        code, data = client.GetImageSample()
        if code != 0:
            continue
        try:
            jpeg = bytes(data)
            # Decode once in capture thread; track only wraps latest frame.
            arr = np.frombuffer(jpeg, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            out.set(img)
        except Exception:
            continue


class Go2VideoTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, shared: SharedFrameBuffer, fps: float) -> None:
        super().__init__()
        self._shared = shared
        self._fps = max(1.0, fps)
        self._last_frame: np.ndarray | None = None
        self._blank = np.zeros((480, 640, 3), dtype=np.uint8)

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        frame_bgr, _ = self._shared.get()
        if frame_bgr is not None:
            self._last_frame = frame_bgr
        if self._last_frame is None:
            await asyncio.sleep(1.0 / self._fps)
            frame = VideoFrame.from_ndarray(self._blank, format="bgr24")
            frame.pts = pts
            frame.time_base = time_base
            return frame

        frame = VideoFrame.from_ndarray(self._last_frame, format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


async def _create_app(args: argparse.Namespace) -> web.Application:
    shared = SharedFrameBuffer()
    stop_evt = threading.Event()
    t = threading.Thread(
        target=_run_capture_thread,
        args=(args.iface, args.fps, shared, stop_evt),
        name="go2-video-capture",
        daemon=True,
    )
    t.start()

    app = web.Application()
    # Disable buffering to keep latency stable and avoid relay queue buildup.
    relay = MediaRelay()
    source_track = Go2VideoTrack(shared, fps=args.fps)
    pcs: set[RTCPeerConnection] = set()
    peer_created_at: dict[RTCPeerConnection, float] = {}
    stale_peer_timeout_s = 30.0

    async def close_peer(pc: RTCPeerConnection, reason: str) -> None:
        # Ensure each peer is closed exactly once and removed from bookkeeping.
        was_tracked = pc in pcs
        pcs.discard(pc)
        peer_created_at.pop(pc, None)
        with contextlib.suppress(Exception):
            await pc.close()
        if was_tracked:
            print(f"[go2_video_webrtc] peer closed ({reason}), peers={len(pcs)}")

    @web.middleware
    async def cors_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
        if request.method == "OPTIONS":
            response = web.Response(status=204)
        else:
            response = await handler(request)
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    app.middlewares.append(cors_middleware)

    async def health(_: web.Request) -> web.Response:
        _, stamp = shared.get()
        age_s = None if stamp <= 0 else max(0.0, time.monotonic() - stamp)
        return web.json_response({"ok": True, "frame_age_s": age_s, "peers": len(pcs)})

    async def offer(request: web.Request) -> web.Response:
        payload = await request.json()
        if payload.get("type") != "offer" or "sdp" not in payload:
            return web.json_response({"error": "invalid offer payload"}, status=400)
        if len(pcs) >= args.max_peers:
            return web.json_response({"error": f"too many peers (max={args.max_peers})"}, status=503)

        pc = RTCPeerConnection()
        pcs.add(pc)
        peer_created_at[pc] = time.monotonic()
        print(f"[go2_video_webrtc] peer connected, peers={len(pcs)}")

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            if pc.connectionState in {"failed", "closed", "disconnected"}:
                await close_peer(pc, pc.connectionState)

        @pc.on("iceconnectionstatechange")
        async def on_iceconnectionstatechange() -> None:
            if pc.iceConnectionState in {"failed", "closed", "disconnected"}:
                await close_peer(pc, f"ice-{pc.iceConnectionState}")

        try:
            track = relay.subscribe(source_track, buffered=False)
            pc.addTrack(track)

            await pc.setRemoteDescription(RTCSessionDescription(sdp=payload["sdp"], type="offer"))
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            assert pc.localDescription is not None
            return web.json_response(
                {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
                dumps=lambda obj: json.dumps(obj),
            )
        except Exception as exc:
            await close_peer(pc, f"offer-error: {exc}")
            return web.json_response({"error": "offer negotiation failed"}, status=500)

    async def close_stale_peers_task() -> None:
        while True:
            await asyncio.sleep(5.0)
            now = time.monotonic()
            stale = [
                pc
                for pc, created_at in list(peer_created_at.items())
                if pc.connectionState in {"new", "connecting"} and (now - created_at) > stale_peer_timeout_s
            ]
            for pc in stale:
                await close_peer(pc, "stale-handshake-timeout")

    async def on_startup(app_: web.Application) -> None:
        app_["peer_gc_task"] = asyncio.create_task(close_stale_peers_task())

    async def on_shutdown(app_: web.Application) -> None:
        gc_task = app_.get("peer_gc_task")
        if gc_task is not None:
            gc_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await gc_task
        stop_evt.set()
        t.join(timeout=1.0)
        coros = [close_peer(pc, "shutdown") for pc in list(pcs)]
        if coros:
            await asyncio.gather(*coros, return_exceptions=True)
        peer_created_at.clear()

    app.add_routes(
        [
            web.get("/health", health),
            web.post("/offer", offer),
        ]
    )
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    return app


def main() -> None:
    p = argparse.ArgumentParser(description="Go2 camera -> WebRTC bridge")
    p.add_argument("--iface", required=True, help="Network interface (example: eth0)")
    p.add_argument("--host", default="0.0.0.0", help="HTTP bind host")
    p.add_argument("--port", type=int, default=8081, help="HTTP signaling port")
    p.add_argument("--fps", type=float, default=15.0, help="Target capture fps")
    p.add_argument("--max-peers", type=int, default=3, help="Maximum simultaneous WebRTC peers")
    args = p.parse_args()

    app = asyncio.run(_create_app(args))
    print(f"[go2_video_webrtc] signaling on http://{args.host}:{args.port}")
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
