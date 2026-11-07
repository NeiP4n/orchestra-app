#!/usr/bin/env bun

// Step 0 request-measurement export (diagnostic only, never a source of charges): folds the
// local JSONL measurement files into one JSON document on stdout. Numbers and IDs only - no
// prompt text, filenames, URLs, headers or keys are ever recorded, so none can appear here.
//
// Usage:
//   bun run packages/core/script/export-measurements.ts [directory]
//
// The directory defaults to ORCHESTRA_REQUEST_MEASUREMENT_DIR, then <data>/log/measurements.
// Collection itself requires ORCHESTRA_REQUEST_MEASUREMENT=1 in the daemon's environment.

import { Effect } from "effect"
import { measurementDir, readExport } from "../src/session/request-measurement.js"

const directory = process.argv[2] ?? measurementDir()
const result = await Effect.runPromise(readExport(directory))
console.log(JSON.stringify(result, null, 2))
