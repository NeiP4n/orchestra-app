#!/usr/bin/env bun
import { $ } from "bun"

import { copyBuiltCliToResources, downloadCliToResources, resolveChannel } from "./utils"

// Fail fast on the wrong bun: package.json pins bun@1.4.2, but bun does
// not enforce the packageManager field when invoked directly, and a
// system bun 1.4.4 has already broken installs with an obscure error.
// Set ORCHESTRA_ALLOW_OTHER_BUN=1 to bypass this check deliberately.
if (Bun.version !== "1.4.2" && !Bun.env.ORCHESTRA_ALLOW_OTHER_BUN) {
  throw new Error(
    `This repo requires bun 1.4.2 (packageManager), but the running bun is ${Bun.version}. ` +
      "Run it with the pinned bun, or set ORCHESTRA_ALLOW_OTHER_BUN=1 to proceed anyway.",
  )
}

const channel = resolveChannel()

if (channel === "prod" && !Bun.env.ORCHESTRA_CLI_DIST) {
  throw new Error("ORCHESTRA_CLI_DIST is required for production desktop builds")
}

await $`bun ./scripts/copy-icons.ts ${channel}`

await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (channel === "dev") await downloadCliToResources()

if ((channel === "beta" || channel === "prod") && Bun.env.ORCHESTRA_CLI_DIST) {
  await copyBuiltCliToResources(Bun.env.ORCHESTRA_CLI_DIST)
}

if (channel === "beta" && !Bun.env.ORCHESTRA_CLI_DIST) await downloadCliToResources("beta")
