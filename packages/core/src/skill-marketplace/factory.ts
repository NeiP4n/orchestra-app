export * as SkillMarketplaceFactory from "./factory.js"

import { resolveIo } from "./resolve.js"
import { estimateTokens } from "./budget.js"
import type { Adapter, Factory, FactoryStep, JournalEntry, NativeSkill, Port } from "./types.js"

/**
 * The "factory": a working production line assembled from the skills the
 * marketplace found. Given the outputs a task needs and the inputs the
 * caller already has, it chains skills so each step's inputs are fed by the
 * task or by an earlier step — with adapters inserted where the types differ
 * but convert, and a refusal (with the reason) where they do not.
 *
 * A derived skill — one without a manifest, so its inputs and outputs are
 * unknown — can never be chained: the factory cannot prove what it needs or
 * produces. It can only run alone, named explicitly by the caller.
 *
 * The composition is bounded: at most five skills deep and eight steps.
 * A factory that needs more than that is not a pipeline, it is a project,
 * and the caller should split the task instead of paying for a chain nobody
 * can follow.
 *
 * Trying a producer is transactional: when one of its inputs cannot be
 * satisfied, every step the attempt added is rolled back, so a failed
 * attempt never leaks half a pipeline into the factory.
 */

export const MAX_DEPTH = 5
export const MAX_STEPS = 8

export interface Goal {
  /** The outputs the task needs. */
  readonly outputs: readonly Port[]
  /** The inputs the caller already has. */
  readonly inputs: readonly Port[]
}

export type Composed =
  | { readonly ok: true; readonly factory: Factory; readonly journal: readonly JournalEntry[] }
  | { readonly ok: false; readonly reason: string; readonly journal: readonly JournalEntry[] }

/**
 * Assembles a factory for a goal from the available skills. Every mismatch
 * is settled here, at build time, by `resolveIo` — never while a skill is
 * running — and every settlement is journaled.
 */
export const compose = (goal: Goal, available: readonly NativeSkill[]): Composed => {
  const journal: JournalEntry[] = []
  const adapters: Adapter[] = []
  const now = Date.now()
  const steps: FactoryStep[] = []
  const used = new Set<string>()
  const provided = new Map<string, { port: Port; from: string }>()
  for (const input of goal.inputs) provided.set(input.name, { port: input, from: "task" })

  const satisfy = (port: Port, depth: number): boolean => {
    if (provided.has(port.name)) return true
    if (depth >= MAX_DEPTH) return false
    const producers = available
      .filter((skill) => !skill.manifest.derived && !used.has(skill.manifest.name))
      .filter((skill) => skill.manifest.outputs.some((output) => output.name === port.name))
    for (const producer of producers) {
      const output = producer.manifest.outputs.find((entry) => entry.name === port.name) as Port
      const resolution = resolveIo(output, port)
      if (!resolution.ok) continue
      // Snapshot: a producer whose inputs cannot be satisfied leaves nothing behind.
      const snapshot = {
        steps: steps.length,
        used: new Set(used),
        provided: new Map(provided),
        adapters: adapters.length,
        journal: journal.length,
      }
      const stepInputs: FactoryStep["inputs"] = []
      let ready = true
      for (const input of producer.manifest.inputs) {
        if (!satisfy(input, depth + 1)) {
          ready = false
          break
        }
        const source = provided.get(input.name)
        if (source === undefined) {
          ready = false
          break
        }
        stepInputs.push({ port: input, from: source.from })
      }
      if (!ready) {
        steps.length = snapshot.steps
        used.clear()
        for (const name of snapshot.used) used.add(name)
        provided.clear()
        for (const [name, value] of snapshot.provided) provided.set(name, value)
        adapters.length = snapshot.adapters
        journal.length = snapshot.journal
        continue
      }
      used.add(producer.manifest.name)
      steps.push({ skill: producer.manifest.name, level: producer.level, inputs: stepInputs, outputs: producer.manifest.outputs })
      for (const out of producer.manifest.outputs) {
        if (!provided.has(out.name)) provided.set(out.name, { port: out, from: `skill:${producer.manifest.name}` })
      }
      if (resolution.adapter !== undefined) {
        adapters.push(resolution.adapter)
        journal.push({
          at: now,
          kind: "factory",
          skill: producer.manifest.name,
          level: producer.level,
          problem: `Port "${port.name}" is ${output.type} but the goal needs ${port.type}.`,
          decision: `Inserted adapter ${output.type} -> ${port.type}: ${resolution.adapter.how}`,
        })
      }
      return true
    }
    return false
  }

  for (const output of goal.outputs) {
    if (steps.length >= MAX_STEPS) {
      return {
        ok: false,
        reason: `The factory needs more than ${MAX_STEPS} steps; split the task instead.`,
        journal: [
          ...journal,
          {
            at: now,
            kind: "factory",
            skill: undefined,
            level: undefined,
            problem: `Goal output "${output.name}" would exceed ${MAX_STEPS} steps.`,
            decision: "Refused: a factory that long is a project, not a pipeline.",
          },
        ],
      }
    }
    if (!satisfy(output, 0)) {
      const derived = available.filter((skill) => skill.manifest.derived).map((skill) => skill.manifest.name)
      return {
        ok: false,
        reason:
          `No skill produces "${output.name}" (${output.type})` +
          (derived.length > 0 ? `; derived skills cannot be chained: ${derived.join(", ")}.` : "."),
        journal: [
          ...journal,
          {
            at: now,
            kind: "factory",
            skill: undefined,
            level: undefined,
            problem: `Goal output "${output.name}" (${output.type}) has no producer among the available skills.`,
            decision: "Refused: the factory cannot be assembled for this goal.",
          },
        ],
      }
    }
  }

  return { ok: true, factory: { steps, adapters }, journal }
}

/** The estimated tokens of loading every skill in a factory, from their texts' lengths. */
export const estimateFactoryTokens = (factory: Factory, texts: ReadonlyMap<string, string>): number =>
  factory.steps.reduce((sum, step) => sum + estimateTokens(texts.get(step.skill) ?? ""), 0)
