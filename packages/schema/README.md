# @orchestra/schema

The foundational data contracts and domain entity definitions of the Orchestra platform.

## Overview

`@orchestra/schema` is the Layer 0 leaf package of the Orchestra monorepo. It declares all serializable data structures, IDs, domain entities, configuration schemas, and event payloads exchanged between packages.

- Built exclusively on `@effect/schema` (Effect v4).
- Zero dependencies on other `@orchestra/*` packages.
- Safe for browser, Node.js, Bun, and Cloudflare Workers (workerd) environments.

## Subsystems

- **Session Models**: Session identities (`Session.ID`), messages (`SessionMessage`), compaction events, revert states, and inbox items.
- **Event Manifests**: Typed server events, durable event manifests, and bus event schemas.
- **Configuration**: Settings for agents, commands, permissions, integrations, and tools.
- **Providers & Models**: Model schemas, token pricing, provider configuration, and credentials.
- **Filesystem & VCS**: File diffs, snapshot descriptors, and Git/VCS references.

## Usage

```ts
import { Session, SessionMessage } from "@orchestra/schema"

const sessionID = Session.ID.create()
const messageID = SessionMessage.ID.create()
```
