import { expect, test } from "bun:test"
import { ProjectTemplateTriggerReview as R } from "../src/project-template-trigger-review"
import { templateFixture } from "./project-template.test"
test("dependency review lists every trigger, even with empty saved links, without guessing accounts", () => {
  const bundle = templateFixture()
  bundle.schedules.push({
    ...bundle.schedules[0],
    slot: "interval",
    source: { kind: "interval", spec: "60", browser: "inbox" },
  })
  bundle.schedules.push({ ...bundle.schedules[0], slot: "time", source: { kind: "cron", spec: "0 9 * * *" } })
  bundle.schedules.push({
    ...bundle.schedules[0],
    slot: "internal",
    source: { kind: "execution.succeeded", session: "main" },
  })
  bundle.browsers[0].links = []
  expect(R.review(bundle, [{ browser: 1, link: 2, reason: "query" }])).toEqual([
    { schedule: 1, browser: 1, reason: "browser-links-omitted" },
    { schedule: 2, browser: 1, reason: "browser-links-omitted" },
    { schedule: 3, reason: "time-review" },
    { schedule: 4, reason: "unsupported-event" },
  ])
  expect(R.fromText(JSON.stringify(bundle))[0]).toEqual({ schedule: 1, browser: 1, reason: "browser-rebind" })
})
