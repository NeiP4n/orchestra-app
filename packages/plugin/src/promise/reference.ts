import type { ReferenceApi } from "@orchestra/client/promise/api"
import type { ReferenceGitSource, ReferenceLocalSource } from "@orchestra/client"
import type { Transform } from "./registration.js"

export interface ReferenceEditor {
  add(name: string, source: ReferenceLocalSource | ReferenceGitSource): void
  remove(name: string): void
  list(): readonly (readonly [string, ReferenceLocalSource | ReferenceGitSource])[]
  get(name: string): ReferenceLocalSource | ReferenceGitSource | undefined
}

export interface ReferenceDomain extends ReferenceApi {
  readonly transform: Transform<ReferenceEditor>
  readonly reload: () => Promise<void>
}
