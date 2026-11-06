import { describe, expect, test } from "bun:test"
import { SocietyStatus } from "@orchestra/core/society-status"

describe("SocietyStatus.summarize", () => {
  test("counts live agents society-wide, across projects", () => {
    // The Б14 shape: the planner's own project has 0 workers, the work is
    // in the federated projects — and most workers never started.
    const status = SocietyStatus.summarize({
      projects: [
        { id: "planner", sessions: [] },
        {
          id: "scouts",
          sessions: [
            { claimed: true },
            { claimed: false, outcome: "succeeded" },
            { claimed: false, outcome: "failed" },
          ],
        },
        {
          id: "builders",
          sessions: [
            { claimed: false },
            { claimed: false },
            { claimed: false, outcome: "interrupted" },
          ],
        },
      ],
    })
    expect(status.projects).toEqual([
      { id: "planner", total: 0, running: 0, succeeded: 0, failed: 0, interrupted: 0, waiting: 0, live: 0 },
      { id: "scouts", total: 3, running: 1, succeeded: 1, failed: 1, interrupted: 0, waiting: 0, live: 2 },
      { id: "builders", total: 3, running: 0, succeeded: 0, failed: 0, interrupted: 1, waiting: 2, live: 2 },
    ])
    expect(status.total).toBe(6)
    expect(status.running).toBe(1)
    expect(status.waiting).toBe(2)
    expect(status.live).toBe(4)
    expect(status.failed).toBe(1)
  })

  test("waiting is not working: a society of never-started sessions has 0 running", () => {
    // The 14:44 live-run shape: 26 workers with a delivered task, outcome
    // None, never started. They are live roster members, not working agents.
    const status = SocietyStatus.summarize({
      projects: [
        {
          id: "team",
          sessions: Array.from({ length: 26 }, () => ({ claimed: false })),
        },
      ],
    })
    expect(status.total).toBe(26)
    expect(status.live).toBe(26)
    expect(status.running).toBe(0)
    expect(status.waiting).toBe(26)
  })

  test("a claimed session with a stale failed outcome still counts as running", () => {
    // The claim is the current run; the outcome is the last one. Until the
    // terminal event lands, the session is running, not failed.
    const status = SocietyStatus.summarize({
      projects: [{ id: "team", sessions: [{ claimed: true, outcome: "failed" }] }],
    })
    expect(status.projects[0]).toMatchObject({ total: 1, running: 1, failed: 1, waiting: 0, live: 1 })
  })
})
