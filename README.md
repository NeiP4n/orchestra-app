<h1 align="center">Orchestra</h1>

<p align="center">A terminal AI coding agent for teams: LAN multiplayer, AI teams with roles, a project DoD board, notes and an Idea Bank.<br>Built on <a href="https://github.com/anomalyco/opencode">OpenCode</a>. Windows, Linux, macOS and Android.</p>

<p align="center"><a href="README.md">English</a> | <a href="README.ru.md">Русский</a></p>

## Install

One command; git and Bun are installed for you if missing.

| System | Command |
| --- | --- |
| Windows (PowerShell) | `irm https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/get.ps1 \| iex` |
| Linux / macOS | `curl -fsSL https://raw.githubusercontent.com/NeiP4n/orchestra-app/main/installer/get.sh \| sh` |

Then open a new terminal and run `orchestra-app`.

**Updates:** run the install command again.

## What's inside

- **LAN rooms** — host a session and let others on the network join with a code: members, roles, bans and a shared DoD. Works between Windows and Linux.
- **AI teams** — an orchestrator hands tasks to roles (architect, developer, tester, reviewer, …). Ready-made templates, your own in `/teams`.
- **Federated groups** — a dedicated Group Orchestrator monitors project orchestrators and workers, summarizes progress and tickets, and receives execution start/finish events. Open Groups and press `Start AI`; the first project is the coordinator. Cross-project requests still follow each receiving project’s own approvals and rules.
- **Project DoD board** — `.opencode/dod.yaml` as a progress panel: what is done, in progress and blocked.
- **Idea Bank** — private ideas from your sessions and an opt-in shared global catalogue with search.
- **Notes** — project notes in Markdown; the AI writes into the selected note.
- **Hub** — a registry of CLI tools to install and enable for the model; Nushell as the AI's shell.
- **Mini skills** — editable buttons above the prompt: Analyze, Plan, Debug, Review, …
- **Shared rate limits** — agents of one provider wait out a cooldown together instead of all hitting it.
- **Phone layout** — `/mobile` folds the side panels to edge rails that open over the screen; on by default in Termux.
- **English and Russian** interface (`/language`).

## Development

```bash
bun install
bun run dev
```

`bun run check` runs lint and type checks. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT, like OpenCode. See [LICENSE](LICENSE).

---

Built with ChatGPT, Claude and Opencode.
