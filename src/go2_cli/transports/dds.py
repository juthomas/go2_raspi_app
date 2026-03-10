"""DDS transport implementation for Unitree GO2."""

from __future__ import annotations

import sys
from typing import Any

from go2_cli.config import AppConfig
from go2_cli.errors import CommandExecutionError
from go2_cli.transports.base import RobotTransport

_CODE_HINTS = {
    0: "OK",
    3102: "Envoi DDS impossible. Verifie le cable ethernet et l'interface reseau.",
    3104: "Timeout RPC. Le robot ne repond pas ou le service n'est pas actif.",
    3203: "API non implementee sur ce firmware.",
    3204: "Parametre API invalide.",
    4202: "Service sport non initialise. Active sport_mode sur le robot.",
    7004: "Service motion_switcher indisponible ou desactive.",
}


def _code_hint(code: int) -> str:
    return _CODE_HINTS.get(code, "Erreur inconnue cote SDK/robot.")


def _looks_like_normal_mode(payload: Any) -> bool:
    if payload is None:
        return False
    return "normal" in str(payload).lower()


class DdsGo2Transport(RobotTransport):
    """Control GO2 via Unitree SDK2 (CycloneDDS + RPC)."""

    def __init__(self, config: AppConfig):
        self._iface = config.iface
        self._timeout_s = config.timeout_s
        self._ensure_normal_mode_flag = config.ensure_normal_mode
        self._strict_normal_mode_flag = config.strict_normal_mode
        self._connected = False
        self._sport_client: Any = None
        self._motion_switcher_client: Any = None

    def connect(self) -> None:
        if not self._iface:
            raise CommandExecutionError(
                "L'option --iface est requise en transport DDS (ex: eth0)."
            )

        try:
            from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import (
                MotionSwitcherClient,
            )
            from unitree_sdk2py.core.channel import ChannelFactoryInitialize
            from unitree_sdk2py.go2.sport.sport_client import SportClient
        except ImportError as exc:
            raise CommandExecutionError(
                "Dependances DDS manquantes/invalides. "
                "Installe cyclonedds puis unitree_sdk2py en editable depuis son repo."
            ) from exc

        try:
            ChannelFactoryInitialize(0, self._iface)
            self._sport_client = SportClient()
            self._sport_client.SetTimeout(self._timeout_s)
            self._sport_client.Init()

            self._motion_switcher_client = MotionSwitcherClient()
            self._motion_switcher_client.SetTimeout(self._timeout_s)
            self._motion_switcher_client.Init()
            self._connected = True
        except Exception as exc:
            raise CommandExecutionError(
                f"Initialisation DDS impossible sur interface '{self._iface}'."
            ) from exc

    def ensure_normal_mode(self) -> None:
        self._require_connected()
        if not self._ensure_normal_mode_flag:
            return

        check_code, payload = self._motion_switcher_client.CheckMode()
        if check_code == 0 and _looks_like_normal_mode(payload):
            return

        select_code, _ = self._motion_switcher_client.SelectMode("normal")
        if select_code != 0:
            message = (
                "Impossible de forcer le mode normal "
                f"(code={select_code}, hint='{_code_hint(select_code)}')."
            )
            if self._strict_normal_mode_flag:
                raise CommandExecutionError(message)
            print(
                f"WARNING: {message} On continue la commande sport.",
                file=sys.stderr,
            )

    def stand_up(self) -> None:
        self._require_connected()
        self.ensure_normal_mode()
        code = self._sport_client.StandUp()
        self._raise_on_code(code, "StandUp")

    def stand_down(self) -> None:
        self._require_connected()
        self.ensure_normal_mode()
        code = self._sport_client.StandDown()
        self._raise_on_code(code, "StandDown")

    def close(self) -> None:
        # SDK2 Python n'expose pas de close explicite pour ces clients.
        self._connected = False
        self._sport_client = None
        self._motion_switcher_client = None

    def _require_connected(self) -> None:
        if not self._connected:
            raise CommandExecutionError("Transport DDS non initialise.")

    def _raise_on_code(self, code: int, operation: str) -> None:
        if code != 0:
            raise CommandExecutionError(
                f"{operation} a echoue (code={code}, hint='{_code_hint(code)}')."
            )
