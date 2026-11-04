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
tools and rules are derived/applied automatically; the budget is automatic
(`AiStandard.budgetFor`, applied through `Limits`). Zero configuration is a
working state. Callers such as `Orchestra.workerModels` consume the standard
and must not re-encode their own priority chain.

## Usage

```ts
import { SessionExecution } from "@orchestra/core/session/execution"
import { SessionStore } from "@orchestra/core/session/store"
```
