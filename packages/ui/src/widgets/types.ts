export type Item = { readonly label: string; readonly hint?: string }

export type FieldKind =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "number"; readonly value: string }
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "select"; readonly options: readonly string[]; readonly at: number }

export type Field = { readonly label: string; readonly kind: FieldKind }

export type Kind =
  | { readonly kind: "choice"; readonly items: readonly Item[]; readonly cursor: number }
  | { readonly kind: "multi"; readonly items: readonly Item[]; readonly on: readonly boolean[]; readonly cursor: number }
  | { readonly kind: "confirm"; readonly text: readonly string[]; readonly yes: string; readonly no: string; readonly cursor: number }
  | { readonly kind: "buttons"; readonly labels: readonly string[]; readonly cursor: number }
  | { readonly kind: "input"; readonly placeholder: string; readonly text: string }
  | { readonly kind: "form"; readonly fields: readonly Field[]; readonly cursor: number }
  | {
      readonly kind: "scale"
      readonly min: number
      readonly max: number
      readonly value: number
      readonly low: string
      readonly high: string
      readonly stars: boolean
    }
  | {
      readonly kind: "table"
      readonly cols: readonly string[]
      readonly rows: readonly (readonly string[])[]
      readonly select: boolean
      readonly cursor: number
    }
  | { readonly kind: "progress"; readonly items: readonly { readonly label: string; readonly fraction: number; readonly shown: string }[] }
  | { readonly kind: "steps"; readonly items: readonly { readonly state: string; readonly label: string }[] }
  | { readonly kind: "diff"; readonly lines: readonly string[]; readonly actions: readonly string[]; readonly cursor: number }
  | { readonly kind: "code"; readonly lang: string; readonly lines: readonly string[] }
  | { readonly kind: "kv"; readonly pairs: readonly (readonly [string, string])[] }
  | { readonly kind: "callout"; readonly tone: string; readonly lines: readonly string[] }
  | { readonly kind: "tabs"; readonly pages: readonly { readonly name: string; readonly lines: readonly string[] }[]; readonly current: number }
  | { readonly kind: "rank"; readonly items: readonly string[]; readonly cursor: number }
  | { readonly kind: "spark"; readonly label: string; readonly values: readonly number[] }
  | { readonly kind: "timeline"; readonly events: readonly (readonly [string, string])[] }
  | { readonly kind: "tree"; readonly nodes: readonly { readonly depth: number; readonly label: string }[]; readonly select: boolean; readonly cursor: number }
  | { readonly kind: "run"; readonly items: readonly { readonly label: string; readonly command: string }[]; readonly cursor: number }

export type Widget = Kind & { readonly title: string; readonly answered?: string }

export type Segment = { readonly type: "text"; readonly text: string } | { readonly type: "widget"; readonly widget: Widget }

export type Key = "up" | "down" | "left" | "right" | "enter" | "tab" | "backtab" | "esc" | "backspace" | (string & {})

export type Outcome =
  | { readonly type: "none" }
  | { readonly type: "answer"; readonly value: string }
  | { readonly type: "copy"; readonly text: string }
  | { readonly type: "release" }
  | { readonly type: "focus-prompt" }

export type Result = { readonly widget: Widget; readonly outcome: Outcome }

export const KINDS = [
  "choice",
  "multi",
  "confirm",
  "buttons",
  "input",
  "form",
  "scale",
  "table",
  "progress",
  "steps",
  "diff",
  "code",
  "kv",
  "callout",
  "tabs",
  "rank",
  "spark",
  "timeline",
  "tree",
  "run",
] as const
