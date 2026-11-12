import { expect, test } from "bun:test"
import { cleanupErrorMessage, SERVER_UPDATE_HINT } from "../src/util/backend-compatibility"
test("cleanup 404 has an actionable update hint, without claiming nothing was removed", () => {
  expect(cleanupErrorMessage(new Error("UnexpectedStatus: 404"), x => x)).toBe(SERVER_UPDATE_HINT)
  expect(cleanupErrorMessage({ cause: { status: 404 } }, x => x)).toBe(SERVER_UPDATE_HINT)
  expect(SERVER_UPDATE_HINT).not.toContain("No sessions were deleted")
  expect(cleanupErrorMessage(new Error("Permission denied"), x => x)).toContain("Permission denied")
})
