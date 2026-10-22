export * as SessionAffinity from "./affinity.js"

import { createHash } from "node:crypto"
import type { SessionSchema } from "./schema.js"

// TODO: Should the `model.request` hook expose affinity so plugins stop deriving it from `ctx.session.get`?
/** The Session ID that groups model requests for provider cache routing: children share the parent's, forks the fork source's. */
export const get = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) =>
  session.parentID ?? session.fork?.sessionID ?? session.id

// OpenCode's own session ids are `ses_` plus lowercase hex, which matches the shape Zen's
// free-tier gateway demands of `x-opencode-session`: `ses_<12 lowercase hex><14 alnum>`.
// The check is a shape only — nothing is registered server-side — but anything outside it
// is answered with 403 "free tier can only be used from within OpenCode". A group chat keeps
// a derived id (`ses_group_…`) so reopening the group finds the same chat, so that shape alone
// would keep every group chat off the free models. For an id outside OpenCode's own, send a
// deterministic hash of it instead: the header only groups provider cache routing for one
// conversation, so it only has to be well formed and stable for the whole conversation.
const ORCHESTRA_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}/

/** The session value model requests carry: the affinity id, in a shape the free-tier gate accepts. */
export const gateway = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) => {
  const id = get(session)
  if (ORCHESTRA_ID.test(id)) return id
  return "ses_" + createHash("sha256").update(id).digest("hex").slice(0, 26)
}
