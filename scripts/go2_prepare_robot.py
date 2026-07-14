#!/usr/bin/env python3
"""
Prepare GO2 robot before starting LiDAR / control WebSocket bridges.

Steps: wait for robot ping, normal mode, utlidar ON, optional mapping_cmd, LiDAR probe.

Exit codes:
  0 — LiDAR frames received
  1 — robot unreachable (ping failed after retries)
  2 — ping OK but no LiDAR frames during probe
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

DEFAULT_MAPPING_CMDS = ("START", "ON", "start_mapping")
DEFAULT_LIDAR_TOPIC = "rt/utlidar/cloud"
DEFAULT_VOXEL_TOPIC = "rt/utlidar/voxel_map_compressed"
DEFAULT_HEIGHT_MAP_TOPIC = "rt/utlidar/height_map_array"


def _looks_like_normal_mode(payload: Any) -> bool:
    return payload is not None and "normal" in str(payload).lower()


def _ping_host(host: str, timeout_s: float) -> bool:
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", str(max(1, int(timeout_s))), host],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        print("[go2_prepare] ERROR: ping command not found", file=sys.stderr)
        return False


def _wait_for_robot(host: str, *, retries: int, interval_s: float, ping_timeout_s: float) -> bool:
    for attempt in range(1, retries + 1):
        if _ping_host(host, ping_timeout_s):
            print(f"[go2_prepare] robot reachable at {host} (attempt {attempt}/{retries})")
            return True
        print(f"[go2_prepare] waiting for robot {host} ({attempt}/{retries})...")
        time.sleep(interval_s)
    return False


def _ensure_normal_mode(motion_switcher: Any, *, strict: bool) -> None:
    check_code, payload = motion_switcher.CheckMode()
    if check_code == 0 and _looks_like_normal_mode(payload):
        print("[go2_prepare] motion mode already normal")
        return

    select_code, _ = motion_switcher.SelectMode("normal")
    if select_code == 0:
        print("[go2_prepare] motion mode set to normal")
        return

    message = f"[go2_prepare] WARN: SelectMode(normal) failed (code={select_code})"
    if strict:
        print(message.replace("WARN:", "ERROR:"), file=sys.stderr)
        raise SystemExit(3)
    print(message, file=sys.stderr)


def _publish_string(topic: str, value: str) -> None:
    from unitree_sdk2py.core.channel import ChannelPublisher
    from unitree_sdk2py.idl.default import std_msgs_msg_dds__String_
    from unitree_sdk2py.idl.std_msgs.msg.dds_ import String_

    pub = ChannelPublisher(topic, String_)
    pub.Init()
    msg = std_msgs_msg_dds__String_()
    msg.data = value
    pub.Write(msg)
    print(f"[go2_prepare] published {topic!r} -> {value!r}")


def _utlidar_on() -> None:
    _publish_string("rt/utlidar/switch", "ON")


def _mapping_cmds(commands: tuple[str, ...], *, delay_s: float) -> None:
    for cmd in commands:
        cmd = cmd.strip()
        if not cmd:
            continue
        try:
            _publish_string("rt/utlidar/mapping_cmd", cmd)
        except Exception as exc:
            print(f"[go2_prepare] WARN: mapping_cmd {cmd!r} failed: {exc}", file=sys.stderr)
        time.sleep(delay_s)


def _probe_lidar(
    iface: str,
    *,
    topic: str,
    duration_s: float,
    queue_len: int,
) -> int:
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
    from unitree_sdk2py.idl.sensor_msgs.msg.dds_ import PointCloud2_

    count = {"n": 0}

    def on_lidar(_msg: Any) -> None:
        count["n"] += 1

    ChannelFactoryInitialize(0, iface)
    sub = ChannelSubscriber(topic, PointCloud2_)
    sub.Init(handler=on_lidar, queueLen=queue_len)

    deadline = time.monotonic() + duration_s
    while time.monotonic() < deadline:
        time.sleep(0.1)

    frames = count["n"]
    print(f"[go2_prepare] LiDAR probe: {frames} frame(s) on {topic} in {duration_s:.1f}s")
    return frames


def _probe_voxel(
    iface: str,
    *,
    topic: str,
    duration_s: float,
    queue_len: int,
) -> int:
    from _voxel_idl import load_voxel_map_compressed_type
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber

    VoxelMapCompressed_ = load_voxel_map_compressed_type()
    count = {"n": 0}

    def on_voxel(_msg: Any) -> None:
        count["n"] += 1

    ChannelFactoryInitialize(0, iface)
    sub = ChannelSubscriber(topic, VoxelMapCompressed_)
    sub.Init(handler=on_voxel, queueLen=queue_len)

    deadline = time.monotonic() + duration_s
    while time.monotonic() < deadline:
        time.sleep(0.1)

    frames = count["n"]
    print(f"[go2_prepare] voxel probe: {frames} frame(s) on {topic} in {duration_s:.1f}s")
    if frames == 0:
        print(
            "[go2_prepare] WARN: no voxel frames — enable 3D LiDAR Mapping in Unitree app "
            "if you need go2_voxel_map",
            file=sys.stderr,
        )
    return frames


def _probe_height_map(
    iface: str,
    *,
    topic: str,
    duration_s: float,
    queue_len: int,
) -> int:
    from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
    from unitree_sdk2py.idl.unitree_go.msg.dds_ import HeightMap_

    count = {"n": 0}

    def on_height_map(_msg: Any) -> None:
        count["n"] += 1

    ChannelFactoryInitialize(0, iface)
    sub = ChannelSubscriber(topic, HeightMap_)
    sub.Init(handler=on_height_map, queueLen=queue_len)

    deadline = time.monotonic() + duration_s
    while time.monotonic() < deadline:
        time.sleep(0.1)

    frames = count["n"]
    print(f"[go2_prepare] height_map probe: {frames} frame(s) on {topic} in {duration_s:.1f}s")
    if frames == 0:
        print(
            "[go2_prepare] WARN: no height_map frames — start mapping recording in Unitree app "
            "and move the robot",
            file=sys.stderr,
        )
    return frames


def main() -> None:
    parser = argparse.ArgumentParser(description="Prepare GO2 before LiDAR/control bridges")
    parser.add_argument("--iface", required=True, help="Network interface (e.g. eth0)")
    parser.add_argument("--robot-ip", default="192.168.123.161", help="Robot IP to ping")
    parser.add_argument("--timeout", type=float, default=10.0, help="RPC timeout (s)")
    parser.add_argument("--ping-retries", type=int, default=30, help="Ping attempts before fail")
    parser.add_argument("--ping-interval", type=float, default=2.0, help="Seconds between pings")
    parser.add_argument("--ping-timeout", type=float, default=2.0, help="Single ping timeout (s)")
    parser.add_argument("--robot-warmup", type=float, default=5.0, help="Sleep after ping OK (s)")
    parser.add_argument("--skip-normal-mode", action="store_true", help="Skip motion_switcher normal")
    parser.add_argument("--strict-normal-mode", action="store_true", help="Fail if normal mode fails")
    parser.add_argument("--skip-utlidar", action="store_true", help="Skip rt/utlidar/switch ON")
    parser.add_argument("--skip-mapping-cmd", action="store_true", help="Skip rt/utlidar/mapping_cmd")
    parser.add_argument(
        "--mapping-cmds",
        default=",".join(DEFAULT_MAPPING_CMDS),
        help="Comma-separated mapping_cmd values (best-effort)",
    )
    parser.add_argument("--mapping-cmd-delay", type=float, default=0.5, help="Delay between mapping cmds")
    parser.add_argument("--lidar-topic", default=DEFAULT_LIDAR_TOPIC, help="LiDAR probe topic")
    parser.add_argument("--probe-duration", type=float, default=5.0, help="LiDAR probe duration (s)")
    parser.add_argument("--probe-queue-len", type=int, default=2, help="DDS queue for probe subscriber")
    parser.add_argument("--skip-probe", action="store_true", help="Skip LiDAR frame probe")
    parser.add_argument("--probe-voxel", action="store_true", help="Probe compressed voxel topic (informational)")
    parser.add_argument("--voxel-topic", default=DEFAULT_VOXEL_TOPIC, help="Voxel probe topic")
    parser.add_argument("--voxel-probe-duration", type=float, default=10.0, help="Voxel probe duration (s)")
    parser.add_argument("--probe-height-map", action="store_true", help="Probe height_map topic (informational)")
    parser.add_argument("--height-map-topic", default=DEFAULT_HEIGHT_MAP_TOPIC, help="HeightMap probe topic")
    parser.add_argument(
        "--height-map-probe-duration",
        type=float,
        default=10.0,
        help="HeightMap probe duration (s)",
    )
    args = parser.parse_args()

    mapping_cmds = tuple(c.strip() for c in args.mapping_cmds.split(",") if c.strip())

    if not _wait_for_robot(
        args.robot_ip,
        retries=args.ping_retries,
        interval_s=args.ping_interval,
        ping_timeout_s=args.ping_timeout,
    ):
        print(f"[go2_prepare] ERROR: robot {args.robot_ip} unreachable", file=sys.stderr)
        raise SystemExit(1)

    if args.robot_warmup > 0:
        print(f"[go2_prepare] robot warmup {args.robot_warmup:.1f}s...")
        time.sleep(args.robot_warmup)

    try:
        from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import MotionSwitcherClient
        from unitree_sdk2py.core.channel import ChannelFactoryInitialize
    except ImportError as exc:
        print(f"[go2_prepare] ERROR: missing DDS deps: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    ChannelFactoryInitialize(0, args.iface)

    if not args.skip_normal_mode:
        motion = MotionSwitcherClient()
        motion.SetTimeout(args.timeout)
        motion.Init()
        _ensure_normal_mode(motion, strict=args.strict_normal_mode)

    if not args.skip_utlidar:
        _utlidar_on()
        time.sleep(0.5)

    if not args.skip_mapping_cmd and mapping_cmds:
        _mapping_cmds(mapping_cmds, delay_s=args.mapping_cmd_delay)

    if args.skip_probe:
        print("[go2_prepare] probe skipped")
        raise SystemExit(0)

    frames = _probe_lidar(
        args.iface,
        topic=args.lidar_topic,
        duration_s=args.probe_duration,
        queue_len=args.probe_queue_len,
    )

    if args.probe_height_map:
        _probe_height_map(
            args.iface,
            topic=args.height_map_topic,
            duration_s=args.height_map_probe_duration,
            queue_len=args.probe_queue_len,
        )

    if args.probe_voxel:
        _probe_voxel(
            args.iface,
            topic=args.voxel_topic,
            duration_s=args.voxel_probe_duration,
            queue_len=args.probe_queue_len,
        )

    if frames <= 0:
        print("[go2_prepare] ERROR: no LiDAR frames — check utlidar and robot state", file=sys.stderr)
        raise SystemExit(2)

    print("[go2_prepare] ready")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
