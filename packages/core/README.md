# @orchestra/core

Core runtime engine and domain services for Orchestra.

## Overview

`@orchestra/core` houses the central execution logic, session lifecycle coordination, model provider integration, persistent storage, and tool execution engine for Orchestra.

- **Sessions & Execution**: `SessionExecution` process-global management, `SessionRunCoordinator` fiber-based concurrency and prompt coalescing, and `SessionRunner` step loops.
- **Storage & Database**: Multi-runtime SQLite client (`bun:sqlite`, `node:sqlite`, and `workerd`) with Drizzle ORM schemas and WAL migration management.
- **Event Bus**: In-memory event routing (`Bus.Service`) with transaction commit hooks and durable SQLite projections.
- **Tools Engine**: Execution harness for bash/shell commands, file operations (read, edit, write, patch, glob, grep), MCP servers, and skill discovery.
- **Model Providers**: Unified LLM client integration, streaming transport adapters, instruction epochs, and automatic context compaction (`SessionCompaction`).

## Package Structure

- `src/session/`: Session state machines, inbox admission, prompt processing, history, and compaction.
- `src/database/`: Database connection pooling, SQLite pragmas, and Drizzle migrations.
- `src/bus.ts`: Publish-subscribe event bus with commit-level guarantees.
- `src/tool/`: Core tool implementations and MCP bridging.
- `src/instructions/`: Dynamic prompt assembly and instruction discovery.

## The Single AI Standard

The operator states the task and keeps a shortlist of favorite models; the
system decides everything else. That standard lives in exactly one place —
[`src/ai-standard.ts`](src/ai-standard.ts) (`AiStandard`) — and fixes, in
priority order: a per-task explicit model wins; the agent and model are
picked from the favorites, ranked for the work (depth vs. speed);
unavailable favorites are skipped and, when all are down, the run falls back
to the role model, then the worker policy, then the caller's model; MCP
tools and rules are derived/applied automatically; the step budget is the
standard's default (`AiStandard.budgetFor`, fed into the runner through
`AiStandard.stepCeilings`) — a ceiling on steps, not a cap on spend, and
like every ceiling it applies only when the deployment enforces limits
(`Limits`). Zero configuration is a working state. Callers such as
`Orchestra.workerModels` consume the standard and must not re-encode their
own priority chain.

## Usage

```ts
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionStore } from "@orchestra/core/session/store"
```


### Klinch model discovery

The built-in provider discovers `https://api.klinch.cloud/v1/models` with the stored active key. Discovery is a catalog GET, not a generation request. Its default budget is 60 seconds. Set `ORCHESTRA_KLINCH_DISCOVERY_TIMEOUT_MS` to an integer from 1000 to 120000 to override it; invalid values use the default.

Transient timeout/network/429/5xx failures retry three times after 1, 5 and 15 seconds without changing credentials. Auth failures do not retry. Later retries run in the plugin scope without holding startup readiness. Concurrent Locations share an in-flight request for the same connection, not a permanent response cache. Safe `Klinch model discovery` logs include state, trigger, attempt, elapsed milliseconds and timeout; no key, headers or raw server error is logged.
