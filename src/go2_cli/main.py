"""CLI entrypoint for go2ctl."""

from __future__ import annotations

import sys

from go2_cli.cli import args_to_config, build_parser
from go2_cli.errors import Go2CliError
from go2_cli.transports import build_transport


def _safety_prompt(command: str) -> None:
    print("WARNING: assure-toi que la zone autour du robot est libre.")
    token = input(f"Confirmer '{command}' en tapant GO: ").strip().upper()
    if token != "GO":
        raise Go2CliError("Commande annulee (confirmation non valide).")


def run(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    config = args_to_config(args)
    transport = None

    try:
        if args.command == "tui":
            from go2_cli.tui import TuiOptions, run_tui

            if not args.yes:
                _safety_prompt("tui")
            return run_tui(
                config=config,
                options=TuiOptions(
                    linear_speed=args.linear_speed,
                    yaw_speed=args.yaw_speed,
                    pitch_speed=args.pitch_speed,
                    step_distance_m=args.step_distance,
                    step_yaw_deg=args.step_yaw_deg,
                    step_pitch_deg=args.step_pitch_deg,
                    profile_start=args.profile,
                    control_mode_start=args.control_mode,
                    hold_timeout_s=args.hold_timeout,
                ),
            )

        transport = build_transport(config)
        transport.connect()

        if args.command in {"stand", "lie"} and not args.yes:
            _safety_prompt(args.command)

        if args.command == "normal-mode":
            transport.ensure_normal_mode()
            print("OK: mode normal actif.")
        elif args.command == "stand":
            transport.stand_up()
            print("OK: commande StandUp envoyee.")
        elif args.command == "lie":
            transport.stand_down()
            print("OK: commande StandDown envoyee.")
        else:
            parser.error(f"Commande non geree: {args.command}")
            return 2

        return 0
    except KeyboardInterrupt:
        print("\nInterrompu par utilisateur.", file=sys.stderr)
        return 130
    except Go2CliError as exc:
        print(f"ERREUR: {exc}", file=sys.stderr)
        return 1
    finally:
        if transport is not None:
            transport.close()


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
