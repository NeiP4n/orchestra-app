// Fixture runner for the two-process DoD race test: takes one item in a
// shared project directory, then exits.
//   bun test/fixture/dod-take-race-runner.ts <directory> <id> <ownerID> <ownerName> [gateFile]
// With a gate file, the runner waits for the file to appear before taking,
// so two runners started together begin at the same moment — the shape of
// the race this fixture exists to catch.
import { existsSync } from "node:fs"
import { Effect } from "effect"
import { Dod } from "@orchestra/core/dod"

const [directory, id, ownerID, ownerName, gateFile] = process.argv.slice(2)
if (directory === undefined || id === undefined || ownerID === undefined || ownerName === undefined) {
  console.error("usage: dod-take-race-runner.ts <directory> <id> <ownerID> <ownerName> [gateFile]")
  process.exit(2)
}

if (gateFile !== undefined) {
  // Both takers spin here until the test opens the gate; without it, process
  // startup skew alone would usually serialize the two writers.
  const deadline = Date.now() + 30_000
  while (!existsSync(gateFile)) {
    if (Date.now() > deadline) {
      console.error("gate file never appeared")
      process.exit(3)
    }
    await Bun.sleep(5)
  }
}

await Effect.runPromise(Dod.take({ directory, id, owner: { id: ownerID, name: ownerName } }))
console.log(`took ${id}`)
