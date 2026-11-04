export * as Interactive from "./interactive.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

// Structured interactive content a model can place inside a conversation:
// decisions, comparisons, approvals, plans and visualizations. This schema
// is the single definition of every block type — the model tool validates
// against it, the backend stores blocks built from it, and clients render
// from it, so no layer hardcodes the list of block types on its own.
//
// Everything here is declarative data. A block can never carry HTML,
// JavaScript, components, commands or any other executable payload, and
// every string and collection is length-capped so a payload stays small
// enough to render anywhere (the tool additionally enforces a total
// serialized-size ceiling). URLs are validated by the tool before a block
// is accepted: only http(s) links may ride in `evidence`/`href` fields.

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const listOf = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMaxLength(max))
const notes = (max: number) => listOf(text(200), max)

/** One selectable option of a decision block. */
export const Option = Schema.Struct({
  id: text(64).annotate({ description: "Stable option id, unique within the block" }),
  label: text(120).annotate({ description: "Option name" }),
  description: text(600).pipe(optional),
  pros: notes(6).pipe(optional).annotate({ description: "Advantages" }),
  cons: notes(6).pipe(optional).annotate({ description: "Disadvantages" }),
  risks: notes(6).pipe(optional),
  consequences: text(600).pipe(optional).annotate({ description: "Expected consequences of choosing this option" }),
  cost: text(120).pipe(optional).annotate({ description: "Implementation cost or complexity, in words" }),
  recommended: Schema.Boolean.pipe(optional),
  evidence: notes(6).pipe(optional).annotate({ description: "Supporting evidence (facts or http(s) links)" }),
}).annotate({ identifier: "Interactive.Option" })
export interface Option extends Schema.Schema.Type<typeof Option> {}

export const Decision = Schema.Struct({
  type: Schema.Literal("decision"),
  title: text(160),
  description: text(1200).pipe(optional),
  options: listOf(Option, 8).check(Schema.isMinLength(2)),
  multiple: Schema.Boolean.pipe(optional).annotate({
    description: "Allow selecting several options instead of exactly one",
  }),
}).annotate({ identifier: "Interactive.Decision" })
export interface Decision extends Schema.Schema.Type<typeof Decision> {}

/** One compared item of a comparison block (a model, library, architecture…). */
export const ComparedItem = Schema.Struct({
  id: text(64),
  name: text(120),
  summary: text(600).pipe(optional),
  attributes: Schema.Record(Schema.String, text(300)).pipe(optional).annotate({
    description: "Named attributes shown as rows of the comparison (price, license, latency…)",
  }),
  strengths: notes(6).pipe(optional),
  weaknesses: notes(6).pipe(optional),
  rating: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 5 })).pipe(optional),
  recommended: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Interactive.ComparedItem" })
export interface ComparedItem extends Schema.Schema.Type<typeof ComparedItem> {}

export const Comparison = Schema.Struct({
  type: Schema.Literal("comparison"),
  title: text(160),
  description: text(1200).pipe(optional),
  items: listOf(ComparedItem, 8).check(Schema.isMinLength(2)),
}).annotate({ identifier: "Interactive.Comparison" })
export interface Comparison extends Schema.Schema.Type<typeof Comparison> {}

/** A proposed action the user approves, rejects or sends back for changes. */
export const Approval = Schema.Struct({
  type: Schema.Literal("approval"),
  title: text(160),
  description: text(1200).pipe(optional),
  action: text(1200).annotate({ description: "Exactly what is being approved, in concrete terms" }),
  consequences: notes(8).pipe(optional),
  risks: notes(8).pipe(optional),
  destructive: Schema.Boolean.pipe(optional).annotate({
    description: "True when the action destroys or irreversibly changes something",
  }),
}).annotate({ identifier: "Interactive.Approval" })
export interface Approval extends Schema.Schema.Type<typeof Approval> {}

/**
 * A structured plan. The task list is a snapshot the model states; when the
 * session belongs to an Orchestra project the tool prefers the project's
 * real stage state and says so in the result, so a plan card never invents
 * progress the stage engine does not have.
 */
export const PlanTask = Schema.Struct({
  title: text(200),
  status: Schema.Literals(["planned", "running", "blocked", "failed", "completed", "cancelled"]),
  detail: text(600).pipe(optional),
  agent: text(64).pipe(optional).annotate({ description: "Assigned agent or role name" }),
  evidence: text(600).pipe(optional),
}).annotate({ identifier: "Interactive.PlanTask" })
export interface PlanTask extends Schema.Schema.Type<typeof PlanTask> {}

export const PlanPhase = Schema.Struct({
  title: text(160),
  tasks: listOf(PlanTask, 24),
}).annotate({ identifier: "Interactive.PlanPhase" })
export interface PlanPhase extends Schema.Schema.Type<typeof PlanPhase> {}

export const Plan = Schema.Struct({
  type: Schema.Literal("plan"),
  title: text(160),
  description: text(1200).pipe(optional),
  phases: listOf(PlanPhase, 12),
}).annotate({ identifier: "Interactive.Plan" })
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const ChartPoint = Schema.Struct({
  label: text(80),
  value: Schema.Number,
}).annotate({ identifier: "Interactive.ChartPoint" })
export interface ChartPoint extends Schema.Schema.Type<typeof ChartPoint> {}

export const ChartSeries = Schema.Struct({
  name: text(80),
  points: listOf(ChartPoint, 60),
}).annotate({ identifier: "Interactive.ChartSeries" })
export interface ChartSeries extends Schema.Schema.Type<typeof ChartSeries> {}

export const Metric = Schema.Struct({
  label: text(80),
  value: text(80),
  detail: text(200).pipe(optional),
}).annotate({ identifier: "Interactive.Metric" })
export interface Metric extends Schema.Schema.Type<typeof Metric> {}

/** Structured data rendered as a chart, metric cards, a progress bar or a table. */
export const Visualization = Schema.Struct({
  type: Schema.Literal("visualization"),
  title: text(160),
  description: text(1200).pipe(optional),
  chart: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("bar"),
      series: listOf(ChartSeries, 6).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      kind: Schema.Literal("line"),
      series: listOf(ChartSeries, 6).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({
      kind: Schema.Literal("pie"),
      series: listOf(ChartSeries, 6).check(Schema.isMinLength(1)),
    }),
    Schema.Struct({ kind: Schema.Literal("metrics"), metrics: listOf(Metric, 12).check(Schema.isMinLength(1)) }),
    Schema.Struct({
      kind: Schema.Literal("progress"),
      label: text(120),
      value: Schema.Number,
      max: Schema.Number,
    }),
    Schema.Struct({
      kind: Schema.Literal("table"),
      columns: listOf(text(80), 8).check(Schema.isMinLength(1)),
      rows: listOf(listOf(text(200), 8), 40),
    }),
  ]).pipe(Schema.toTaggedUnion("kind")),
}).annotate({ identifier: "Interactive.Visualization" })
export interface Visualization extends Schema.Schema.Type<typeof Visualization> {}

/** A block as the model supplies it: no id or timestamps yet. */
export const Block = Schema.Union([Decision, Comparison, Approval, Plan, Visualization])
  .pipe(Schema.toTaggedUnion("type"), Schema.annotate({ identifier: "Interactive.Block" }))
export type Block = Decision | Comparison | Approval | Plan | Visualization

/** The user's validated answer to an interactive (form-backed) block. */
export const Response = Schema.Struct({
  /** Chosen option/item ids (decision and comparison blocks). */
  selected: Schema.Array(Schema.String).pipe(optional),
  /** Approval outcome (approval blocks). */
  decision: Schema.Literals(["approved", "rejected", "changes-requested"]).pipe(optional),
  /** Free-form text the user added: a custom answer or a comment. */
  comment: Schema.String.pipe(optional),
}).annotate({ identifier: "Interactive.Response" })
export interface Response extends Schema.Schema.Type<typeof Response> {}
