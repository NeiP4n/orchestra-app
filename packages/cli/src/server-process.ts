export * as ServerProcess from "./server-process"

import { runProcess } from "./server-process-internal"
import type { Options } from "./server-process-internal"
export type { Mode, Options } from "./server-process-internal"

// Public entry keeps the original single-options signature. No test dependencies accepted.
export const run = (options: Options) => runProcess(options)
