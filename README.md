<h1 align="center">Orchestra</h1>

<p align="center">A terminal AI coding agent and orchestration platform for teams: LAN multiplayer, AI teams with specialized roles, a project Definition of Done (DoD) board, notes, and an Idea Bank.<br>Windows, Linux, macOS, and Android.</p>

<p align="center"><a href="README.md">English</a> | <a href="README.ru.md">Русский</a></p>

## Install

One command; git and Bun are installed for you if missing.

| System | Command |
| --- | --- |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/get.ps1 \| iex` |
| Linux / macOS | `curl -fsSL https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/get.sh \| sh` |

Then open a new terminal and run `orchestra-app` (or `orchestra`).

**Updates:** run the install command again.

## What's inside

- **LAN rooms** — host a session and let others on the network join with a code: members, roles, permissions, and a shared DoD board. Cross-platform across Windows, Linux, and macOS.
- **AI teams** — an orchestrator assigns and tracks tasks across roles (architect, developer, tester, reviewer, and custom specialists). Pre-configured templates, customizable in `/teams`.
- **Federated groups** — a dedicated Group Orchestrator monitors project orchestrators and workers, summarizes cross-project progress and tickets, and receives lifecycle events. Open Groups and start the coordinator.
- **Project DoD board** — `.orchestra/dod.yaml` (or `.opencode/dod.yaml`) as an interactive progress panel: completed, in-progress, and blocked steps with verification commands.
- **Idea Bank** — private ideas extracted from your development sessions and an opt-in shared global catalogue with fast search.
- **Notes** — project notes in Markdown with automatic AI contextual integration.
- **Hub & Tool Registry** — a comprehensive registry of CLI and MCP tools to install and enable for models; Nushell as a modern agent shell.
- **Mini skills** — contextual action buttons above the prompt: Analyze, Plan, Debug, Review, Test.
- **Shared rate limits** — agents targeting the same model or provider coordinate cooldown periods cooperatively.
- **Mobile layout** — `/mobile` folds side panels to edge rails; enabled automatically in Termux and Android shells.
- **Bilingual UI** — Full English and Russian support (`/language`).

## Monorepo Architecture

Orchestra is built on Effect v4 and organized into distinct layers:

- `packages/schema` — browser-safe wire and storage contract schemas.
- `packages/protocol` — canonical HTTP and WebSocket API contracts using Effect HttpApi.
- `packages/core` — domain services: sessions, runner, coordinator, model tools, storage, and bus.
- `packages/server` — transport layer mounting protocol contracts and SSE event feeds.
- `packages/client` — generated typed clients (Promise, Effect, and Solid).
- `packages/cli` — CLI entrypoint, background daemon service, and ACP integration.
- `packages/tui` — terminal user interface with SolidJS and OpenTUI.
- `packages/app` — web and desktop shell frontend.

## Development

```bash
bun install
bun run dev
```

`bun run check` runs lint and type checks across all packages. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).

---

Built with ChatGPT, Claude, and Orchestra.
