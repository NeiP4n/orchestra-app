export * as SocietyStatus from "./society-status.js"

// Society-wide status (idea "role toolkits", 2026-11-06): how many agents the
// WHOLE Society has, not just one project.
//
// The Б14 planner counted 0 workers in its own project while 27 agents were
// working in other projects through federation — and later (14:44) the
// opposite miscount: 26 of 27 workers had outcome "None", which reads as
// "working" but means "not finished" — they had a delivered task and had
// never started. Both mistakes come from counting one project, or from
// reading one ambiguous field. This module counts every project of a group
// from the same two durable signals, and names each bucket so the planner
// cannot misread it:
//
// - `running`: the session holds an execution claim right now
//   (`SessionStore.listSuspended`). A claim that survives a crash also
//   reads as running here — it is a turn that never completed, and the
//   restart recovery resumes it, so treating it as running is the honest
//   reading until the terminal event lands.
// - `succeeded` / `failed` / `interrupted`: the last idle outcome
//   (`idle_outcome`), written only by a terminal execution event.
// - `waiting`: the session exists and never went idle — a delivered task
//   nobody started, the Б14 shape. This is NOT "working".
// - `live`: every session that did not die: everything except a session
//   whose last outcome is failed/interrupted AND which holds no claim.
//   A running session is alive by definition, even when its last outcome
//   was failed (the stale-outcome case the projector fix clears on drain
//   start). It is a roster size, not activity: a live society can still be
//   all waiting, and `running` is the number that says otherwise.
//
// Only counts leave this module: no session IDs, no titles, no names, no
// transcripts. The federation tool's `group_status` publishes the counts
// for the same reason its activity rows are sanitized — a Group Orchestrator
// may know how many agents work, never which sessions they are.

export type Outcome = "succeeded" | "failed" | "interrupted"

export interface SessionSnapshot {
  /** The last idle outcome, if the session ever went idle. */
  readonly outcome?: Outcome
  /** Whether the session holds an execution claim right now. */
  readonly claimed: boolean
}

export interface ProjectSnapshot {
  readonly id: string
  readonly sessions: ReadonlyArray<SessionSnapshot>
}

export interface ProjectStatus {
  readonly id: string
  readonly total: number
  readonly running: number
  readonly succeeded: number
  readonly failed: number
  readonly interrupted: number
  readonly waiting: number
  readonly live: number
}

export interface Status {
  readonly projects: ReadonlyArray<ProjectStatus>
  readonly total: number
  readonly running: number
  readonly succeeded: number
  readonly failed: number
  readonly interrupted: number
  readonly waiting: number
  readonly live: number
}

const empty = { total: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0, waiting: 0, live: 0 }

function countProject(project: ProjectSnapshot): ProjectStatus {
  const status: ProjectStatus = { id: project.id, ...empty }
  for (const session of project.sessions) {
    status.total++
    if (session.claimed) status.running++
    if (session.outcome === "succeeded") status.succeeded++
    else if (session.outcome === "failed") status.failed++
    else if (session.outcome === "interrupted") status.interrupted++
    else if (!session.claimed) status.waiting++
    // Dead means idle AND terminal: a running session is alive even when
    // its last outcome was failed (stale outcome, cleared on drain start).
    if (!session.claimed && (session.outcome === "failed" || session.outcome === "interrupted")) continue
    status.live++
  }
  return status
}

export function summarize(input: { readonly projects: ReadonlyArray<ProjectSnapshot> }): Status {
  const projects = input.projects.map(countProject)
  const total = { ...empty }
  for (const project of projects) {
    total.total += project.total
    total.running += project.running
    total.succeeded += project.succeeded
    total.failed += project.failed
    total.interrupted += project.interrupted
    total.waiting += project.waiting
    total.live += project.live
  }
  return { projects, ...total }
}
