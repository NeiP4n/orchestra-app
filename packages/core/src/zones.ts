export * as Zones from "./zones.js"

import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { ProjectDirs } from "./project-dirs.js"

export class ZonesError extends Schema.TaggedError<ZonesError>()("Zones.Error", {
  message: Schema.String,
}) {}

// Zones with customs (idea #25): a zone is a slice of the DoD board owned by one
// group. Taking an item out of a foreign zone needs a pass from that zone's owner —
// but the pass is granted by itself when the item hangs without movement: a stale
// claim (lease expired) is an automatic pass, so a jam never lasts forever.
// The registry lives next to the board: `.orchestra/zones.yaml` (legacy `.opencode/`).
export const FILE = ProjectDirs.primary("zones.yaml")
export const LEGACY_FILE = ProjectDirs.legacy("zones.yaml")

// The society's reserve group (idea #19): a group with no planned tasks of its own,
// whose agents are the standbys that pick up stalled work. A group is a reserve
// group by name only — nothing else in the registry marks it.
export const RESERVE_GROUP = "reserve"

/** Whether the group is the society's reserve group (no planned tasks, standby only). */
export function isReserveGroup(group: string): boolean {
  return group.trim() === RESERVE_GROUP
}

const Zone = Schema.Struct({
  name: Schema.String,
  owner_group: Schema.String,
  owner_id: Schema.String.pipe(Schema.optional),
})
const Pass = Schema.Struct({
  zone: Schema.String,
  group: Schema.String,
  granted_at: Schema.String,
  granted_by: Schema.String,
})
const RegistrySchema = Schema.Struct({
  zones: Schema.Array(Zone).pipe(Schema.optional),
  passes: Schema.Array(Pass).pipe(Schema.optional),
})

export interface Zone extends Schema.Schema.Type<typeof Zone> {}
export interface Pass extends Schema.Schema.Type<typeof Pass> {}
export interface Registry {
  zones: readonly Zone[]
  passes: readonly Pass[]
}

const EMPTY: Registry = { zones: [], passes: [] }

const HEADER = [
  "# Zones: which group owns which slice of the DoD board.",
  "# An item belongs to the zone named by its group. Taking an item out of a",
  "# foreign zone needs a pass (see passes below); a stale claim is an automatic",
  "# pass, so a jam never lasts forever. The reserve group `reserve` holds no",
  "# planned tasks — its agents are the standbys.",
  "",
].join("\n")

/** Reads the registry; a project without one has no zones and no restrictions. */
export const load = Effect.fn("Zones.load")(function* (directory: string) {
  const file = ProjectDirs.resolveRead(directory, "zones.yaml")
  const exists = yield* Effect.tryPromise({
    try: () => Bun.file(file).exists(),
    catch: (cause) =>
      new ZonesError({
        message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  if (!exists) return EMPTY
  const text = yield* Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: (cause) =>
      new ZonesError({
        message: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
  return yield* decode(text, file)
})

function decode(text: string, file: string) {
  return Effect.try({
    try: () => Bun.YAML.parse(text),
    catch: () => new ZonesError({ message: `${file} does not parse as YAML` }),
  }).pipe(
    Effect.flatMap((data) => {
      const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(RegistrySchema)(data))
      if (decoded === undefined)
        return Effect.fail(new ZonesError({ message: `${file} is not a zones registry: need zones/passes lists` }))
      return Effect.succeed({ zones: decoded.zones ?? [], passes: decoded.passes ?? [] } satisfies Registry)
    }),
  )
}

export const save = Effect.fn("Zones.save")(function* (directory: string, registry: Registry) {
  const file = ProjectDirs.resolveWrite(directory, "zones.yaml")
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(path.dirname(file), { recursive: true })
      const temporary = path.join(path.dirname(file), `.zones-${Date.now()}.tmp`)
      await writeFile(temporary, render(registry), { flag: "wx", mode: 0o644 })
      await rename(temporary, file)
    },
    catch: (cause) =>
      new ZonesError({
        message: `Could not write ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  })
})

function render(registry: Registry) {
  const lines = [HEADER]
  if (registry.zones.length === 0) lines.push("zones: []")
  else {
    lines.push("zones:")
    for (const zone of registry.zones) {
      lines.push(`  - name: ${JSON.stringify(zone.name)}`)
      lines.push(`    owner_group: ${JSON.stringify(zone.owner_group)}`)
      if (zone.owner_id) lines.push(`    owner_id: ${JSON.stringify(zone.owner_id)}`)
    }
  }
  if (registry.passes.length === 0) lines.push("passes: []")
  else {
    lines.push("passes:")
    for (const pass of registry.passes) {
      lines.push(`  - zone: ${JSON.stringify(pass.zone)}`)
      lines.push(`    group: ${JSON.stringify(pass.group)}`)
      lines.push(`    granted_at: ${JSON.stringify(pass.granted_at)}`)
      lines.push(`    granted_by: ${JSON.stringify(pass.granted_by)}`)
    }
  }
  return `${lines.join("\n")}\n`
}

/** The zone an item's group belongs to, if any. No zone means no restriction. */
export function zoneOf(registry: Registry, group: string): Zone | undefined {
  return registry.zones.find((zone) => zone.name === group)
}

/** An explicit pass letting the group take items from the zone, if one was granted. */
export function passFor(registry: Registry, zone: string, group: string): Pass | undefined {
  return registry.passes.find((pass) => pass.zone === zone && pass.group === group)
}

/**
 * Whether the group is foreign to the zone: the zone exists, has an owner group,
 * and the group is not it. An ungrouped caller is foreign to every owned zone.
 */
export function isCrossZone(registry: Registry, zoneName: string, group: string | undefined): boolean {
  const zone = zoneOf(registry, zoneName)
  if (!zone) return false
  if (group === undefined) return true
  return zone.owner_group !== group
}

/**
 * Why the group may not take an item of the zone, or undefined when it may:
 * its own zone, an explicit pass, or a stale claim — the automatic pass, so a
 * jam never lasts forever. The caller records the automatic pass in the DoD
 * event log; this function only decides.
 */
export function claimRefusal(
  registry: Registry,
  input: { id: string; stage: string; stale?: boolean },
  group: string | undefined,
): string | undefined {
  const zone = zoneOf(registry, input.stage)
  if (!zone) return undefined
  if (group !== undefined && zone.owner_group === group) return undefined
  if (input.stale) return undefined
  if (group !== undefined && passFor(registry, zone.name, group)) return undefined
  return (
    `${input.id} is in zone ${JSON.stringify(zone.name)} owned by ${JSON.stringify(zone.owner_group)}; ` +
    `a pass from its owner is needed to take it` +
    (group === undefined ? ` (no group was given, so the caller is foreign to every zone)` : ``) +
    `. A stale claim grants the pass by itself.`
  )
}

/** Names or replaces the owner of a zone. Creates the registry when there is none. */
export const register = Effect.fn("Zones.register")(function* (
  directory: string,
  zone: { name: string; ownerGroup: string; ownerID?: string },
) {
  const name = zone.name.trim()
  if (!name) return yield* new ZonesError({ message: "Name the zone" })
  const ownerGroup = zone.ownerGroup.trim()
  if (!ownerGroup) return yield* new ZonesError({ message: `Zone ${name} needs an owner group` })
  const registry = yield* load(directory)
  const next: Registry = {
    zones: [
      ...registry.zones.filter((entry) => entry.name !== name),
      { name, owner_group: ownerGroup, ...(zone.ownerID ? { owner_id: zone.ownerID } : {}) },
    ],
    passes: registry.passes,
  }
  yield* save(directory, next)
  return next
})

/** Removes a zone and every pass into it. Fails when the zone does not exist. */
export const unregister = Effect.fn("Zones.unregister")(function* (directory: string, name: string) {
  const registry = yield* load(directory)
  if (!registry.zones.some((zone) => zone.name === name))
    return yield* new ZonesError({ message: `There is no zone ${JSON.stringify(name)}` })
  yield* save(directory, {
    zones: registry.zones.filter((zone) => zone.name !== name),
    passes: registry.passes.filter((pass) => pass.zone !== name),
  })
  return registry.zones.filter((zone) => zone.name !== name)
})

/** Grants the group a pass into the zone. The pass is recorded with who gave it. */
export const grantPass = Effect.fn("Zones.grantPass")(function* (
  directory: string,
  input: { zone: string; group: string; by: string },
) {
  const registry = yield* load(directory)
  if (!registry.zones.some((zone) => zone.name === input.zone))
    return yield* new ZonesError({ message: `There is no zone ${JSON.stringify(input.zone)} to pass into` })
  const group = input.group.trim()
  if (!group) return yield* new ZonesError({ message: "A pass needs a group to grant it to" })
  const pass: Pass = {
    zone: input.zone,
    group,
    granted_at: new Date().toISOString(),
    granted_by: input.by,
  }
  yield* save(directory, {
    zones: registry.zones,
    passes: [...registry.passes.filter((entry) => !(entry.zone === pass.zone && entry.group === pass.group)), pass],
  })
  return pass
})

/** Takes a pass back. Fails when no such pass exists. */
export const revokePass = Effect.fn("Zones.revokePass")(function* (
  directory: string,
  input: { zone: string; group: string },
) {
  const registry = yield* load(directory)
  if (!passFor(registry, input.zone, input.group))
    return yield* new ZonesError({
      message: `Group ${JSON.stringify(input.group)} has no pass into zone ${JSON.stringify(input.zone)}`,
    })
  yield* save(directory, {
    zones: registry.zones,
    passes: registry.passes.filter((pass) => !(pass.zone === input.zone && pass.group === input.group)),
  })
})
