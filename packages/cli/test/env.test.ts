import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits server credentials", () => {
  const previousPassword = process.env.ORCHESTRA_PASSWORD
  const previousLegacyPassword = process.env.ORCHESTRA_SERVER_PASSWORD
  const previousValue = process.env.ORCHESTRA_SESSION_ENV_TEST
  process.env.ORCHESTRA_PASSWORD = "password"
  process.env.ORCHESTRA_SERVER_PASSWORD = "legacy"
  process.env.ORCHESTRA_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.ORCHESTRA_PASSWORD
  else process.env.ORCHESTRA_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.ORCHESTRA_SERVER_PASSWORD
  else process.env.ORCHESTRA_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.ORCHESTRA_SESSION_ENV_TEST
  else process.env.ORCHESTRA_SESSION_ENV_TEST = previousValue

  expect(environment.ORCHESTRA_PASSWORD).toBeUndefined()
  expect(environment.ORCHESTRA_SERVER_PASSWORD).toBeUndefined()
  expect(environment.ORCHESTRA_SESSION_ENV_TEST).toBe("included")
})
