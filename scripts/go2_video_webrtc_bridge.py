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
import json
import threading
import time
from typing import Any

import numpy as np
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.contrib.media import MediaRelay
from av import VideoFrame


class SharedJpegBuffer:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jpeg: bytes | None = None
        self._stamp = 0.0

    def set(self, jpeg: bytes) -> None:
        with self._lock:
            self._jpeg = jpeg
            self._stamp = time.monotonic()

    def get(self) -> tuple[bytes | None, float]:
        with self._lock:
            return self._jpeg, self._stamp


def _run_capture_thread(iface: str, fps: float, out: SharedJpegBuffer, stop_evt: threading.Event) -> None:
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
            # Quick validation to avoid sending malformed frames to WebRTC.
            arr = np.frombuffer(jpeg, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                continue
            out.set(jpeg)
        except Exception:
            continue


class Go2VideoTrack(VideoStreamTrack):
    kind = "video"

    def __init__(self, shared: SharedJpegBuffer, fps: float) -> None:
        super().__init__()
        self._shared = shared
        self._fps = max(1.0, fps)
        self._last_jpeg: bytes | None = None

    async def recv(self) -> VideoFrame:
        import cv2

        pts, time_base = await self.next_timestamp()
        jpeg, _ = self._shared.get()
        if jpeg is not None:
            self._last_jpeg = jpeg
        if self._last_jpeg is None:
            await asyncio.sleep(1.0 / self._fps)
            frame = VideoFrame(width=640, height=480, format="bgr24")
            frame.pts = pts
            frame.time_base = time_base
            return frame

        arr = np.frombuffer(self._last_jpeg, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            await asyncio.sleep(1.0 / self._fps)
            frame = VideoFrame(width=640, height=480, format="bgr24")
            frame.pts = pts
            frame.time_base = time_base
            return frame
        frame = VideoFrame.from_ndarray(img, format="bgr24")
        frame.pts = pts
        frame.time_base = time_base
        return frame


async def _create_app(args: argparse.Namespace) -> web.Application:
    shared = SharedJpegBuffer()
    stop_evt = threading.Event()
    t = threading.Thread(
        target=_run_capture_thread,
        args=(args.iface, args.fps, shared, stop_evt),
        name="go2-video-capture",
        daemon=True,
    )
    t.start()

    app = web.Application()
    relay = MediaRelay()
    pcs: set[RTCPeerConnection] = set()

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

        pc = RTCPeerConnection()
        pcs.add(pc)
        print(f"[go2_video_webrtc] peer connected, peers={len(pcs)}")

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            if pc.connectionState in {"failed", "closed", "disconnected"}:
                await pc.close()
                pcs.discard(pc)
                print(f"[go2_video_webrtc] peer closed ({pc.connectionState}), peers={len(pcs)}")

        track = relay.subscribe(Go2VideoTrack(shared, fps=args.fps))
        pc.addTrack(track)

        await pc.setRemoteDescription(RTCSessionDescription(sdp=payload["sdp"], type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        assert pc.localDescription is not None
        return web.json_response(
            {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type},
            dumps=lambda obj: json.dumps(obj),
        )

    async def on_shutdown(_: web.Application) -> None:
        stop_evt.set()
        coros = [pc.close() for pc in pcs]
        if coros:
            await asyncio.gather(*coros, return_exceptions=True)
        pcs.clear()

    app.add_routes(
        [
            web.get("/health", health),
            web.post("/offer", offer),
        ]
    )
    app.on_shutdown.append(on_shutdown)
    return app


def main() -> None:
    p = argparse.ArgumentParser(description="Go2 camera -> WebRTC bridge")
    p.add_argument("--iface", required=True, help="Network interface (example: eth0)")
    p.add_argument("--host", default="0.0.0.0", help="HTTP bind host")
    p.add_argument("--port", type=int, default=8081, help="HTTP signaling port")
    p.add_argument("--fps", type=float, default=15.0, help="Target capture fps")
    args = p.parse_args()

    app = asyncio.run(_create_app(args))
    print(f"[go2_video_webrtc] signaling on http://{args.host}:{args.port}")
    web.run_app(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
