"""Configuration models used by the CLI."""

from dataclasses import dataclass


@dataclass(frozen=True)
class AppConfig:
    """Runtime configuration for the selected transport."""

    transport: str
    iface: str | None
    timeout_s: float
    ensure_normal_mode: bool
    strict_normal_mode: bool
