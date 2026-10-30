export * as SessionHold from "./hold.js"

import { Effect } from "effect"

// A session can be held: it never starts running, however it is woken (a prompt, a ticket, an inbox item, the
// restart sweep). Who is held is not the session layer's business, and the layers above it (a Society's
// membership) depend on it, so the holder installs a predicate here and every start goes through it.
type Held = (sessionID: string) => Effect.Effect<boolean>

let predicate: Held | undefined

export const install = (held: Held) => {
  predicate = held
}

export const held = (sessionID: string): Effect.Effect<boolean> => (predicate ? predicate(sessionID) : Effect.succeed(false))
