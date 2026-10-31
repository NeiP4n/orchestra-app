// Plain data of the code graph: what the indexer stores and what the queries return. Everything here
// is serializable, so the tool, the CLI and the tests share one vocabulary without Effect types.

export type SymbolKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "variable"

export interface Symbol {
  readonly id: string
  readonly name: string
  /** Qualified name when the symbol lives inside a class. */
  readonly container?: string
  readonly kind: SymbolKind
  /** Repository-relative path with forward slashes. */
  readonly path: string
  /** 1-based. */
  readonly line: number
  readonly column: number
  readonly endLine: number
  readonly exported: boolean
}

export type EdgeKind = "call" | "import"

export interface Edge {
  /** Symbol id for calls, repository-relative file path for imports. */
  readonly src: string
  /** Callee name for calls, resolved module path or raw specifier for imports. */
  readonly dst: string
  readonly kind: EdgeKind
  readonly path: string
  readonly line: number
}

export interface ImportedModule {
  readonly specifier: string
  readonly line: number
}

export interface ExtractedFile {
  readonly path: string
  readonly imports: readonly ImportedModule[]
  readonly symbols: readonly Symbol[]
  /** Import edges use the raw specifier; the indexer resolves them against the known files. */
  readonly edges: readonly Edge[]
}

export interface Fingerprint {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
  readonly hash: string
}

export interface IndexReport {
  readonly root: string
  readonly database: string
  readonly files: number
  readonly indexed: number
  readonly removed: number
  readonly unchanged: number
  readonly symbols: number
  readonly edges: number
  readonly milliseconds: number
}

export interface SearchHit {
  readonly symbol: Symbol
  readonly score: number
}

export interface CallerRef {
  readonly name: string
  readonly kind: SymbolKind | "module"
  readonly path: string
  readonly line: number
}

export interface CalleeRef {
  readonly name: string
  readonly path: string
  readonly line: number
  readonly calls: number
}

export interface ExploreResult {
  readonly symbol: Symbol
  readonly callers: readonly CallerRef[]
  readonly callees: readonly CalleeRef[]
  /** Modules that import the file of the symbol. */
  readonly importers: readonly string[]
}

export interface ImpactRing {
  readonly depth: number
  readonly callers: readonly CallerRef[]
}

export interface ImpactResult {
  readonly target: Symbol
  readonly rings: readonly ImpactRing[]
  /** Every file that has to be looked at again: the target, its callers and its importers. */
  readonly files: readonly string[]
  readonly total: number
  readonly truncated: boolean
  /** Names the walk refused to expand because many declarations share them. */
  readonly ambiguous: readonly string[]
}

export interface GraphStatus {
  readonly root: string
  readonly database: string
  readonly indexed: boolean
  readonly files: number
  readonly symbols: number
  readonly edges: number
  readonly indexedAt?: number
}
