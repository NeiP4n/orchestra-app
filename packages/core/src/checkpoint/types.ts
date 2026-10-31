// A checkpoint is the content of every path `git status` reports as changed, stored once per distinct
// blob and described by a manifest entry. Nothing else is copied: tracked files that did not change are
// already in git, and ignored files (node_modules, build output) never enter a snapshot.

export type ChangeKind = "added" | "modified" | "deleted" | "untracked" | "renamed"

export interface Change {
  /** Repository-relative path with forward slashes. */
  readonly path: string
  readonly kind: ChangeKind
  /** The previous path of a rename. */
  readonly from?: string
}

export interface FileEntry {
  readonly path: string
  readonly kind: ChangeKind
  /** The previous path, for a rename. */
  readonly from?: string
  /** Content hash of the saved blob; absent when the file was deleted in this snapshot. */
  readonly hash?: string
  /** Uncompressed size in bytes. */
  readonly size?: number
}

export interface Moment {
  readonly id: string
  readonly name: string
  readonly created: number
  readonly files: readonly FileEntry[]
  /** Bytes of the saved working tree. */
  readonly bytes: number
  /** Bytes on disk after zstd, counting each distinct blob once. */
  readonly stored: number
}

export interface Index {
  readonly version: number
  readonly moments: readonly Moment[]
}

export type PreviewAction = "write" | "delete" | "unchanged"

export interface PreviewFile {
  readonly path: string
  readonly action: PreviewAction
  readonly currentHash?: string
  readonly savedHash?: string
}

export interface Preview {
  readonly moment: Moment
  readonly files: readonly PreviewFile[]
  /** Paths changed in the working tree that the snapshot does not contain; a restore leaves them alone. */
  readonly extra: readonly string[]
  readonly writes: number
  readonly deletes: number
  readonly unchanged: number
}

export interface RestoreReport {
  readonly moment: Moment
  readonly written: number
  readonly deleted: number
  readonly unchanged: number
  /** Snapshot taken before the restore, so the restore itself can be undone. */
  readonly safety?: string
}

export interface GcReport {
  readonly removed: number
  readonly kept: number
}

// The modules below run from a CLI as well as from a tool, so failures are plain errors with a message
// the operator can act on, not an Effect error channel.
export class CheckpointError extends Error {
  readonly code: "not-a-repository" | "missing" | "exists" | "corrupt"

  constructor(code: CheckpointError["code"], message: string) {
    super(message)
    this.name = "CheckpointError"
    this.code = code
  }
}
