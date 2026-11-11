export * as ConfigOrchestra from "./orchestra.js"

import { Schema } from "effect"
import { PositiveInt, optional } from "../schema.js"
import { ConfigModel } from "./model.js"

// A team worker runs its role's own model when the role sets one. These models answer for a
// role that sets none, so workers can stay off the Orchestrator's model and its limits.
// `model` is the model the worker starts on; `models` are the ones it may continue on when the
// provider refuses the current model outright instead of failing the task. An explicit model
// from the role or from a single task always wins.
export class Policy extends Schema.Class<Policy>("Config.Orchestra.Worker.Policy")({
  model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Model a worker runs when its role sets none, as provider/model or provider/model#variant",
  }),
  models: Schema.Array(ConfigModel.Selection).pipe(optional).annotate({
    description: "Models a worker may continue on when the provider refuses its current model",
  }),
}) {}

export class Worker extends Schema.Class<Worker>("Config.Orchestra.Worker")({
  ...Policy.fields,
  categories: Schema.Record(Schema.String, Policy).pipe(optional).annotate({
    description: "Per role category overrides of model and models, matched ignoring case (Planning, Build, Quality, ...)",
  }),
}) {}

// Cycle limits for the native autoloop (packages/core/src/autoloop). Every
// number is a limit, not a prompt hint: the kernel reads them from the
// decide environment and enforces them in code. Anything missing falls back
// to the kernel defaults (maxAttempts 2, maxVerifyIterations 5, maxHops 8,
// retryBaseMinutes 5, retryMaxMinutes 60, runLeaseMinutes 5,
// workerFreshMinutes 2, offlineAfterMinutes 10, failureRepeatStop 3,
// toolPruneUnusedSteps 10).
export class Autoloop extends Schema.Class<Autoloop>("Config.Orchestra.Autoloop")({
  maxAttempts: PositiveInt.pipe(optional).annotate({
    description: "Failed-run retries before the run stops (default 2; the original autoloop used 10)",
  }),
  maxVerifyIterations: PositiveInt.pipe(optional).annotate({
    description: "Check-fix rounds before the run stops and asks a human (default 5)",
  }),
  failureRepeatStop: PositiveInt.pipe(optional).annotate({
    description: "Same-error repeats that stop a run early, before the retry or check caps run out (default 3)",
  }),
  toolPruneUnusedSteps: PositiveInt.pipe(optional).annotate({
    description:
      "Steps a tool may go unused in a session before the runner stops sending its definition with every request (default 10; TokenEconomizer p=10)",
  }),
  maxHops: PositiveInt.pipe(optional).annotate({
    description: "How deep a chain of events causing events may get before it stops (default 8)",
  }),
  retryBaseMinutes: PositiveInt.pipe(optional).annotate({
    description: "First retry pause in minutes; doubles per attempt up to retryMaxMinutes (default 5)",
  }),
  retryMaxMinutes: PositiveInt.pipe(optional).annotate({
    description: "Retry pause cap in minutes (default 60)",
  }),
  runLeaseMinutes: PositiveInt.pipe(optional).annotate({
    description: "How long a claimed run can go unmentioned before it is in doubt, in minutes (default 5)",
  }),
  workerFreshMinutes: PositiveInt.pipe(optional).annotate({
    description: "A worker seen this recently counts as present, in minutes (default 2)",
  }),
  offlineAfterMinutes: PositiveInt.pipe(optional).annotate({
    description: "How long work waits on a silent worker before the owner hears, in minutes (default 10)",
  }),
  batchWindowMs: PositiveInt.pipe(optional).annotate({
    description: "How long single router events accumulate before one decision pass, in milliseconds (default 1000)",
  }),
  maxBatchEvents: PositiveInt.pipe(optional).annotate({
    description: "How many router events force one decision pass at once, however fresh (default 50)",
  }),
}) {}

// One of the Society's base projects, as the operator configured it. A Society
// always starts from the built-in four (planner, architects, coders, testers);
// setting baseProjects replaces that list wholesale, so an operator who runs
// a different standing crew does not have to fight the code for it. A list
// that fails to decode, or an entry missing a field, falls back to the
// built-in four with a warning instead of breaking Society creation.
// These classes sit above `Info`: it references `Society`, and a class used
// before its declaration breaks the whole module at load time.
export class BaseProject extends Schema.Class<BaseProject>("Config.Orchestra.Society.BaseProject")({
  key: Schema.String,
  folder: Schema.String,
  name: Schema.String,
  role: Schema.String,
  brief: Schema.String,
}) {}

export class Society extends Schema.Class<Society>("Config.Orchestra.Society")({
  baseProjects: Schema.Array(BaseProject).pipe(optional).annotate({
    description: "The Society's base projects, replacing the built-in planner/architects/coders/testers when set",
  }),
  autonomy: Schema.Literals(["off", "observe", "auto"]).pipe(optional).annotate({
    description:
      "How much work the Society's router may take on its own (default auto): off takes nothing, observe prepares runs but executes none, auto executes",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.Orchestra")({
  worker: Worker.pipe(optional),
  autoloop: Autoloop.pipe(optional),
  society: Society.pipe(optional),
}) {}
