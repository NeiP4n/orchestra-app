# Interactive Responses — architecture and contracts

Date: 2026-11-04. Base: `main` @ `2926fda`. Delivered directly to `main`.

## What this is

A first-class interactive response system built **on the existing Form
engine** — no second form system was created. The model places structured
blocks in the conversation with one tool, `interact`; decision, comparison
and approval blocks are answered through the same validated form channel
the `question` tool already uses, and plan/visualization blocks render as
cards in the transcript from the tool call's own persisted data.

Flow: model calls `interact` → the tool validates the block against
`@orchestra/schema/interactive` (plus authoring rules) → for answered
blocks it opens a Form (`metadata.kind: "interactive"`, the block in
`metadata.block`, correlation in `metadata.tool`) and blocks in
`Form.ask` → clients render the pending form and post the reply through
the existing `session.form.reply` endpoint → the Form service validates
the answer against the fields → the tool maps it back to a structured
`Interactive.Response` and returns it as the tool result (with
`interactiveBlock`/`interactiveResponse` metadata) → the model continues
with the actual answer. Cancellation follows the question tool's exact
semantics (a dismissal with a message is model-facing feedback; a bare
dismissal dies as `QuestionTool.CancelledError`).

## Block types (`packages/schema/src/interactive.ts`)

The schema file is the single definition of the block list; the tool,
backend and renderers all derive from it.

- **decision** — 2–8 options, each with pros/cons/risks/consequences/cost/
  evidence and a `recommended` flag; optional `multiple` for multi-select;
  the person may also write a custom answer and a comment.
- **comparison** — 2–8 items with attributes, strengths/weaknesses,
  optional 0–5 rating and recommendation; the person sends one item back.
- **approval** — the exact action, consequences, risks, a `destructive`
  flag; outcomes are the closed set approved / rejected /
  changes-requested, plus an optional comment. **An approval is the
  person's decision about a proposal, never a permission grant**: the
  tool asserts no permissions for the underlying action, and the model
  result text says so. Execution still goes through the normal permission
  system.
- **plan** — phases with tasks (status, agent, detail, evidence). When
  the session belongs to an Orchestra project with workflow stages, the
  tool replaces the model's snapshot with the project's **real stage
  state** and reports `source: "stages"`; otherwise the snapshot is
  labelled `source: "model"`. No second task tracker exists: stages stay
  the system of record (the DoD board and sidebar read the same state).
- **visualization** — bar/line/pie series, metric cards, a progress
  value, or a table. Values render exactly as supplied; the tool's text
  output is a terminal-native rendering (ASCII bars, percentages) that
  every client can show as-is.

Every string and collection is length-capped in the schema; the tool adds
a 32 KB total-payload ceiling, unique-id enforcement, and link safety
(only http(s) URLs may appear as links; scriptable schemes are rejected).
Blocks are pure data: the schema has no field that can carry HTML,
scripts, components or commands, and decoders strip undeclared fields,
so a smuggled payload never reaches storage or a renderer.

## The tool (`packages/core/src/tool/plugin/interact.ts`)

One tool, `interact`, registered beside `question` in
`packages/core/src/plugin/internal.ts` as a core tool (all agents).
Form-backed blocks reuse the `question` permission action, because they
are the same human-interaction channel. Display blocks (plan,
visualization) need no interaction permission — they format the model's
own output. The tool description and the Orchestrator prompt both state
when cards are appropriate; simple questions stay with `question`/text.

Team behaviour is inherited from the form channel: a worker's interactive
block blocks its task the same way a worker question does, arrives at the
Orchestrator as a team question, and an Orchestrator answer is attributed
through the existing `FormDecision` note (`answeredBy` in the tool
metadata, rendered by clients). A session can only create blocks in its
own conversation, and form replies are scoped by the existing
session/form endpoints — a response cannot cross sessions or projects.

## Persistence and recovery

- Pending blocks are Form records: they survive client navigation,
  session switching and reconnection (clients re-list pending forms per
  session) and are deduplicated by form id — the same event delivered
  twice renders one card.
- Settled blocks cannot be answered again (`Form.AlreadySettledError`);
  unknown ids are `Form.NotFoundError`.
- Completed blocks live in the transcript as the tool call itself: input
  (the block), output text (the answer summary / chart text) and metadata
  (block + structured response) are persisted message data, so history
  shows the final state after any restart.
- Like the existing question flow, a **server** restart cancels pending
  asks (the Form service is in-memory with a 10-minute settled-state
  retention); the model receives the cancellation and can re-ask. This is
  the pre-existing guarantee of the form channel, kept deliberately.

## Clients

- **TUI** — rich rendering in both places: `FormPrompt`
  (`routes/session/form.tsx`) shows an interactive details section
  (trade-offs, risks, the exact action) above the generic fields, which
  carry selection/comment input with full keyboard navigation; the
  transcript (`routes/session/index.tsx`, `Interact` tool renderer +
  `util/interactive.ts` narrowing helpers) draws the completed card with
  the chosen option/outcome, plan progress and charts (unicode bars),
  using semantic theme tokens only — the theme contrast registry test
  covers the surfaces these render on.
- **Web/desktop app** — the question dock renders any form's fields, and
  the request model now accepts `kind: "interactive"` alongside
  `"question"` (`session/requests/model.ts`), so blocks are fully
  answerable there with the block's substance composed into field
  descriptions by the tool. The app transcript uses its generic tool
  presentation (block input + the tool's text answer). Rich card
  rendering in the app is the one deliberate gap; the fallback loses no
  information and no answer path.

## Adding a block type

1. Add the variant to `packages/schema/src/interactive.ts` (with caps).
2. Decide answered vs display: answered types map to form fields in
   `toFields`/`responseOf`; display types return `interactiveBlock`
   metadata with a text rendering.
3. Render it in the TUI transcript switch and, if answered, in the
   `FormPrompt` details section — both narrow through
   `util/interactive.ts`, which is where the new view shape goes.
4. Extend the schema/tool/lifecycle tests.

## Tests executed for this delivery

- schema `interactive.test.ts` — valid blocks of all five types;
  malformed payloads rejected (unknown type, <2 options, >8 options,
  rating out of range, oversized strings, unknown plan status); smuggled
  executable fields stripped by decoding.
- core `interact.test.ts` — authoring validation (duplicate ids,
  dangerous schemes rejected, plain prose with colons allowed, payload
  ceiling), form-field mapping incl. the form engine's own answer
  validation (closed approval set rejects arbitrary values), model-facing
  answer text, terminal chart rendering.
- core `interact-lifecycle.test.ts` — on the real Form service: ask
  blocks until reply, replies map to structured responses, settled
  blocks reject second answers, forged ids are not found, pending blocks
  are scoped to their session, cancellation settles the ask, custom
  answers are preserved verbatim.
- Regression: `form`, `form-decision`, `tool-dod-integration`,
  `orchestra-factory-verification` suites pass; app
  `session-request-tree` tests pass; TUI `interactive-util` tests pass.
- Typechecks: schema and client clean; core at its pre-existing baseline
  (8, none in new files); TUI shows only the core baseline via project
  references; app shows only the two pre-existing `route.tsx` errors.
