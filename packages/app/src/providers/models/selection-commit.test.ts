import { expect, test } from "bun:test"
import { commitSessionSelection, type SessionSelectionCommitInput } from "./selection-commit"

const picked = { agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4" }, variant: "high" }
const durable = { agent: "build", model: { providerID: "anthropic", id: "claude-sonnet-4", variant: "high" } }

function harness(overrides: Partial<SessionSelectionCommitInput> = {}) {
  const calls: string[] = []
  const cancels: unknown[] = []
  const errors: unknown[] = []
  const failures = new Map<string, Error>()

  const input: SessionSelectionCommitInput = {
    sessionID: "ses_1",
    selection: picked,
    session: durable,
    track: (selection) => {
      calls.push(`track:${selection.agent}/${selection.model.providerID}/${selection.model.modelID}`)

      return () => {
        cancels.push(selection)
      }
    },
    switchAgent: async (value) => {
      calls.push(`switchAgent:${value.agent}`)
      const failure = failures.get("switchAgent")

      if (failure) throw failure
    },
    switchModel: async (value) => {
      calls.push(`switchModel:${value.model.providerID}/${value.model.id}/${value.model.variant ?? ""}`)
      const failure = failures.get("switchModel")

      if (failure) throw failure
    },
    onError: (error) => {
      errors.push(error)
    },
    ...overrides,
  }

  return { input, calls, cancels, errors, failures }
}

test("commitSessionSelection does nothing without a session", () => {
  const { input, calls } = harness({ sessionID: undefined })

  expect(commitSessionSelection(input)).toBeUndefined()
  expect(calls).toEqual([])
})

test("commitSessionSelection does nothing without a picked model", () => {
  const { input, calls } = harness({ selection: { agent: "build", model: undefined } })

  expect(commitSessionSelection(input)).toBeUndefined()
  expect(calls).toEqual([])
})

test("commitSessionSelection does nothing for an unknown session", () => {
  const { input, calls } = harness({ session: undefined })

  expect(commitSessionSelection(input)).toBeUndefined()
  expect(calls).toEqual([])
})

test("commitSessionSelection commits to a session that has no model yet", async () => {
  const { input, calls } = harness({ session: {} })

  await commitSessionSelection(input)

  expect(calls).toEqual([
    "track:build/anthropic/claude-sonnet-4",
    "switchAgent:build",
    "switchModel:anthropic/claude-sonnet-4/high",
  ])
})

test("commitSessionSelection does nothing when the server already reports the pick", () => {
  const { input, calls } = harness()

  expect(commitSessionSelection(input)).toBeUndefined()
  expect(calls).toEqual([])
})

test("commitSessionSelection switches only the model when the agent matches", async () => {
  const other = { providerID: "openai", modelID: "gpt-5", variant: undefined }
  const { input, calls } = harness({
    selection: { agent: "build", model: other, variant: undefined },
  })

  await commitSessionSelection(input)

  expect(calls).toEqual(["track:build/openai/gpt-5", "switchModel:openai/gpt-5/"])
})

test("commitSessionSelection switches the agent before the model", async () => {
  const { input, calls } = harness({
    selection: { ...picked, agent: "plan" },
  })

  await commitSessionSelection(input)

  expect(calls).toEqual([
    "track:plan/anthropic/claude-sonnet-4",
    "switchAgent:plan",
    "switchModel:anthropic/claude-sonnet-4/high",
  ])
})

test("commitSessionSelection switches the model on a variant-only change", async () => {
  const { input, calls } = harness({
    selection: { ...picked, variant: "low" },
  })

  await commitSessionSelection(input)

  expect(calls).toEqual(["track:build/anthropic/claude-sonnet-4", "switchModel:anthropic/claude-sonnet-4/low"])
})

test("commitSessionSelection cancels the pending commit and reports a failed switch", async () => {
  const failure = new Error("switch failed")
  const { input, calls, cancels, errors, failures } = harness({
    selection: { agent: "build", model: { providerID: "openai", modelID: "gpt-5" }, variant: undefined },
  })
  failures.set("switchModel", failure)

  const done = commitSessionSelection(input)

  expect(done).toBeDefined()
  await expect(done).rejects.toBe(failure)
  // Let the rejection handler run before asserting its effects.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual(["track:build/openai/gpt-5", "switchModel:openai/gpt-5/"])
  expect(cancels.length).toBe(1)
  expect(errors).toEqual([failure])
})

test("commitSessionSelection never switches the model when the agent switch fails", async () => {
  const failure = new Error("agent switch failed")
  const { input, calls, cancels, errors, failures } = harness({
    selection: { ...picked, agent: "plan" },
  })
  failures.set("switchAgent", failure)

  const done = commitSessionSelection(input)

  await expect(done).rejects.toBe(failure)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(calls).toEqual(["track:plan/anthropic/claude-sonnet-4", "switchAgent:plan"])
  expect(cancels.length).toBe(1)
  expect(errors).toEqual([failure])
})
