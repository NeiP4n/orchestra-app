# @orchestra/cli

The command-line interface, background daemon, and execution entrypoint for Orchestra.

## Overview

`@orchestra/cli` is the primary executable surface of Orchestra. It exposes interactive commands, background service lifecycle management, terminal sessions, and Agent Client Protocol (ACP) mode.

- **Interactive TUI**: Launches the terminal interface (`orchestra` or `orchestra tui`).
- **HTTP/WS Daemon**: Starts the local or network server (`orchestra serve`).
- **Headless Execution**: Runs scripted agent runs (`orchestra run`).
- **Service Management**: Controls background daemons across development channels (`orchestra service`).
- **ACP Server**: Provides IDE integration adhering to the Agent Client Protocol.

## Common Commands

```bash
# Start the interactive terminal interface
orchestra

# Start the background server on a custom port
orchestra serve --port 4096

# Run a prompt or script non-interactively
orchestra run --prompt "Refactor session execution loop"

# Inspect background service status
orchestra service status
```

## Structure

- `src/index.ts`: CLI entrypoint, argument parsing, and command dispatch.
- `src/commands/`: Lazy-loaded command handlers (`serve`, `run`, `tui`, `service`, etc.).
- `src/services/`: Service configuration, IPC channels, and port discovery.
- `src/acp/`: Agent Client Protocol integration.
