"""Abstract transport contracts for robot control backends."""

from abc import ABC, abstractmethod


class RobotTransport(ABC):
    """Defines the minimum transport surface needed by the CLI."""

    @abstractmethod
    def connect(self) -> None:
        """Initialize transport resources."""

    @abstractmethod
    def ensure_normal_mode(self) -> None:
        """Ensure robot is in normal motion mode when required."""

    @abstractmethod
    def stand_up(self) -> None:
        """Command robot to stand up."""

    @abstractmethod
    def stand_down(self) -> None:
        """Command robot to lie down."""

    @abstractmethod
    def close(self) -> None:
        """Best-effort cleanup."""
