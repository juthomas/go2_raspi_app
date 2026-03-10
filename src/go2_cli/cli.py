"""Argument parsing for go2ctl."""

from __future__ import annotations

import argparse

from go2_cli.config import AppConfig
from go2_cli.transports import SUPPORTED_TRANSPORTS


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="go2ctl",
        description="CLI GO2 (Raspberry Pi) avec transport extensible (DDS/UDP/WebRTC).",
    )
    parser.add_argument(
        "--transport",
        default="dds",
        choices=SUPPORTED_TRANSPORTS,
        help="Backend de communication (defaut: dds).",
    )
    parser.add_argument(
        "--iface",
        default=None,
        help="Interface reseau ethernet connectee au robot (ex: eth0).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Timeout RPC en secondes (defaut: 10).",
    )
    parser.add_argument(
        "--ensure-normal-mode",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Force le mode motion 'normal' avant la commande (defaut: actif).",
    )
    parser.add_argument(
        "--strict-normal-mode",
        action=argparse.BooleanOptionalAction,
        default=False,
        help=(
            "Si actif, echec immediat si le mode normal ne peut pas etre force. "
            "Sinon, warning non bloquant."
        ),
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Bypass du prompt de securite avant mouvement.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("stand", help="Lever le robot (StandUp).")
    subparsers.add_parser("lie", help="Coucher le robot (StandDown).")
    subparsers.add_parser(
        "normal-mode", help="Forcer uniquement le mode normal (sans mouvement)."
    )
    tui_parser = subparsers.add_parser(
        "tui",
        help=(
            "Mode ncurses teleoperation (WASD=joystick gauche, "
            "fleches=joystick droit)."
        ),
    )
    tui_parser.add_argument(
        "--linear-speed",
        type=float,
        default=0.35,
        help="Vitesse lineaire m/s pour chaque impulsion WASD (defaut: 0.35).",
    )
    tui_parser.add_argument(
        "--yaw-speed",
        type=float,
        default=0.9,
        help="Vitesse de rotation rad/s pour impulsions fleches gauche/droite.",
    )
    tui_parser.add_argument(
        "--pitch-speed",
        type=float,
        default=0.8,
        help="Vitesse pitch rad/s pour impulsions fleches haut/bas.",
    )
    tui_parser.add_argument(
        "--step-distance",
        type=float,
        default=0.16,
        help="Distance m par appui WASD (defaut: 0.16).",
    )
    tui_parser.add_argument(
        "--step-yaw-deg",
        type=float,
        default=12.0,
        help="Angle deg par appui fleche gauche/droite (defaut: 12).",
    )
    tui_parser.add_argument(
        "--step-pitch-deg",
        type=float,
        default=6.0,
        help="Angle deg par appui fleche haut/bas (defaut: 6).",
    )
    tui_parser.add_argument(
        "--profile",
        choices=("safe", "indoor", "outdoor"),
        default=None,
        help="Preset initial de vitesses/amplitudes (safe, indoor, outdoor).",
    )
    tui_parser.add_argument(
        "--control-mode",
        choices=("step", "hold"),
        default="step",
        help="Mode initial: step (impulsions) ou hold (maintien touche).",
    )
    tui_parser.add_argument(
        "--hold-timeout",
        type=float,
        default=0.24,
        help=(
            "Temps max entre repeats clavier en mode hold avant auto-stop "
            "(defaut: 0.24s)."
        ),
    )
    tui_parser.add_argument(
        "--sequence-file",
        default="go2_sequence.json",
        help=(
            "Fichier JSON de sequence pour le mode TUI "
            "(record/play/save/load)."
        ),
    )
    tui_parser.add_argument(
        "--teach-file",
        default="go2_teach.json",
        help=(
            "Fichier JSON du mode Teach (capture manuelle articulations + replay)."
        ),
    )
    tui_parser.add_argument(
        "--teach-speed",
        type=float,
        default=1.25,
        help="Facteur vitesse replay Teach (defaut: 1.25).",
    )
    tui_parser.add_argument(
        "--teach-blend",
        type=float,
        default=0.35,
        help="Duree blend-in Teach au demarrage, en secondes (defaut: 0.35).",
    )
    return parser


def args_to_config(args: argparse.Namespace) -> AppConfig:
    return AppConfig(
        transport=args.transport,
        iface=args.iface,
        timeout_s=args.timeout,
        ensure_normal_mode=args.ensure_normal_mode,
        strict_normal_mode=args.strict_normal_mode,
    )
