import type { ModelKey } from "./selection"

// The local agent/model pick for one session or draft: the shape `useLocal`
// stores per session. Kept structural so this decision stays testable without
// rendering the selection context.
export type CommittableSelection = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

export const sameSelection = (a: CommittableSelection, b: CommittableSelection) =>
  a.agent === b.agent &&
  a.model?.providerID === b.model?.providerID &&
  a.model?.modelID === b.model?.modelID &&
  (a.variant ?? "default") === (b.variant ?? "default")

export type SessionSelectionCommitInput = {
  sessionID: string | undefined
  selection: CommittableSelection
  session:
    | {
        agent?: string
        model?: { providerID: string; id: string; variant?: string }
      }
    | undefined
  track: (selection: { agent: string; model: ModelKey; variant?: string }) => () => void
  switchAgent: (input: { sessionID: string; agent: string }) => Promise<unknown>
  switchModel: (input: {
    sessionID: string
    model: { id: string; providerID: string; variant?: string }
  }) => Promise<unknown>
  onError: (error: unknown) => void
}

// Applies a picked agent/model to an open session right away, instead of waiting
// for the next message to carry it. Returns undefined when there is nothing to
// send: no session, no picked model, an unknown session, or a selection the
// server already reports. The server deduplicates an unchanged selection, so a
// repeated commit is a no-op there too.
export function commitSessionSelection(input: SessionSelectionCommitInput): Promise<void> | undefined {
  const { sessionID, selection, session } = input

  if (!sessionID || !selection.agent || !selection.model) return
  if (!session) return

  // A session without a model yet (created without one, or not synced) still
  // takes the pick: anything differs from "no model".
  const durable = session.model
    ? {
        agent: session.agent,
        model: { providerID: session.model.providerID, modelID: session.model.id },
        variant: session.model.variant,
      } satisfies CommittableSelection
    : undefined

  if (durable && sameSelection(selection, durable)) return

  const commit = {
    agent: selection.agent,
    model: selection.model,
    variant: selection.variant ?? undefined,
  }
  const cancel = input.track(commit)
  const agentSwitch =
    session.agent !== commit.agent
      ? input.switchAgent({ sessionID, agent: commit.agent })
      : Promise.resolve()
  const done: Promise<void> = agentSwitch.then(async () => {
    await input.switchModel({
      sessionID,
      model: { id: commit.model.modelID, providerID: commit.model.providerID, variant: commit.variant },
    })
  })

  done.then(undefined, (error) => {
    cancel()
    input.onError(error)
  })

  return done
}
