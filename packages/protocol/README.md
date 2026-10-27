# @orchestra/protocol

The declarative HTTP and real-time API contract for the Orchestra platform.

## Overview

`@orchestra/protocol` defines the complete public API surface of Orchestra using Effect's `HttpApi`. It specifies endpoint routes, parameters, request bodies, success responses, and typed errors without containing any execution or handler logic.

- Built on Effect `HttpApi` and `@orchestra/schema`.
- Serves as the single source of truth for both `@orchestra/server` implementation and `@orchestra/client` code generation.
- Strict Layer 1 dependency: depends only on `@orchestra/schema`.

## Subsystems

- `src/api.ts`: Root API specification assembling all domain endpoint groups.
- `src/groups/`: Endpoint group declarations (sessions, models, providers, agents, commands, config, files, git, terminal/pty, etc.).
- `src/errors.ts`: Canonical API error schemas.

## Client Generation

When modifying the protocol contract or endpoint groups, regenerate client bindings:

```bash
cd packages/client
bun run generate
bun run check:generated
```
