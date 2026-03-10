"""Transport registry and factory helpers."""

from go2_cli.config import AppConfig
from go2_cli.errors import CommandExecutionError
from go2_cli.transports.base import RobotTransport
from go2_cli.transports.dds import DdsGo2Transport
from go2_cli.transports.udp import UdpGo2Transport
from go2_cli.transports.webrtc import WebRtcGo2Transport

SUPPORTED_TRANSPORTS = ("dds", "udp", "webrtc")


def build_transport(config: AppConfig) -> RobotTransport:
    """Instantiate a transport from configuration."""
    if config.transport == "dds":
        return DdsGo2Transport(config)
    if config.transport == "udp":
        return UdpGo2Transport()
    if config.transport == "webrtc":
        return WebRtcGo2Transport()
    raise CommandExecutionError(f"Transport inconnu: {config.transport}")
