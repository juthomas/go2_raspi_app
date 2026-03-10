"""WebRTC transport placeholder for future extension."""

from go2_cli.errors import UnsupportedTransportError
from go2_cli.transports.base import RobotTransport


class WebRtcGo2Transport(RobotTransport):
    """Reserved slot for future WebRTC implementation."""

    def connect(self) -> None:
        raise UnsupportedTransportError(
            "Transport WebRTC pas encore implemente. Utilise --transport dds."
        )

    def ensure_normal_mode(self) -> None:
        raise UnsupportedTransportError("Transport WebRTC pas encore implemente.")

    def stand_up(self) -> None:
        raise UnsupportedTransportError("Transport WebRTC pas encore implemente.")

    def stand_down(self) -> None:
        raise UnsupportedTransportError("Transport WebRTC pas encore implemente.")

    def close(self) -> None:
        return
