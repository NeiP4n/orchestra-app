# @orchestra/server

The HTTP and WebSocket transport layer for the Orchestra platform.

## Overview

`@orchestra/server` mounts the canonical API specification defined in `@orchestra/protocol` onto Effect's `HttpApiBuilder`. It connects incoming HTTP requests and WebSocket streams to the underlying domain services in `@orchestra/core`, providing real-time event distribution and authorization.

- Built on Effect v4 HTTP server abstractions (`@effect/platform`, `HttpApiBuilder`).
- Provides Server-Sent Events (SSE) for reactive event streaming.
- WebSocket streaming for interactive terminal (PTY) sessions.
- Process and service authentication middleware.

## Subsystems

- `src/routes.ts`: Master API assembly and layer provision.
- `src/handlers/`: Concrete route handlers delegating to Core domain services.
- `src/middleware/`: Authentication, CORS, error transformation, and request tracing.
- `src/pty.ts`: WebSocket transport handler for interactive terminal execution.
- `src/events.ts`: Server-sent event stream broadcaster.

## Usage

```ts
import { Server } from \"@orchestra/server\"
```
