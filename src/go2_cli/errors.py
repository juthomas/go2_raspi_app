"""Domain errors for the GO2 CLI."""


class Go2CliError(Exception):
    """Base error for this application."""


class UnsupportedTransportError(Go2CliError):
    """Raised when transport is known but not implemented."""


class CommandExecutionError(Go2CliError):
    """Raised when a robot command fails."""
