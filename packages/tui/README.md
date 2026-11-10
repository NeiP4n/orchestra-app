# @orchestra/tui

The terminal user interface for Orchestra, built on SolidJS and OpenTUI.

## Overview

`@orchestra/tui` powers the full terminal interface of Orchestra. It provides a rich, responsive console environment with multi-tab session management, real-time streaming Markdown rendering, interactive tool approvals, and modal dialogs.

- **Reactive Terminal Rendering**: Built using `@opentui/solid` for high-performance terminal DOM rendering.
- **Session Navigation**: Multi-tab workspace, session switching, and prompt coalescing visualization.
- **Interactive Modals**: Dialogs for model selection, provider configuration, themes, experiments, and AI teams.
- **Team & LAN Integration**: Displays team member activities, DoD board progress, and federated group statuses.
- **Mobile Mode**: Responsive automatic mobile view that collapses sidebars for compact terminal and mobile (Termux) workflows.

## Subsystems

- `src/index.tsx`: TUI bootstrapping, terminal lifecycle, and keybinding dispatch.
- `src/component/`: Terminal components (chat message timeline, prompt input, dialogs, status bar).
- `src/context/`: Reactive contexts for client data, storage channels, and theme tokens.
- `src/theme/`: Semantic theme definitions, discovery, and token resolutions.

## Running in Development

```bash
# Live TUI connected to background service
bun run dev:live
```

### TUI command changes

- `/auth` opens provider connections; `/models` selects a model. In `/models`, `ctrl+d` saves the selected model as the default for new sessions.
- `/freebuff` is the single Freebuff entry. Balance, timers, account switching and adding accounts are inside that dialog.
- `/compat` is for tools from other agents, not provider authentication or the native tool registry (`/registry`).
- `/help` contains the documentation link. `/docs`, `/default-model` (`/default`), `/mobile` (`/phone`) and `/state-effects` are removed.
- Manual mobile layout and state pulses remain TUI configuration settings: `layout: "mobile"` and `stateEffects: false`.
