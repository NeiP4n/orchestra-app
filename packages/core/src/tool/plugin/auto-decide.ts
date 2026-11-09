export * as AutoDecide from "./auto-decide.js"

import { Effect, Option } from "effect"
import { Config } from "../../config.js"

// In `auto` the Orchestrator decides how to solve a task itself. The question tool and the interact
// decision/comparison blocks used to put that choice to the operator ("which mod?", "which approach?"),
// even with a recommended option on screen. Here those choices are made in code: the recommended option
// (else the first) is taken and the answer says who decided. Anything about money, secrets or publishing
// in the operator's name still reaches the operator, and so does every approval block.

// Wide on purpose: a false match only means the operator is asked, which is the safe direction.
const SENSITIVE =
  /\b(money|pay|paid|payment|purchase|buy|bought|price|billing|invoice|subscription|credit card|bank|wallet|password|passcode|passphrase|secret|api[ -]?key|token|credentials?|publish|tweet|send (an? )?(e-?mail|message))\b|деньг|оплат|платн|плат[иеёю]|куп(и|ить|лю)\b|стоимост|подписк|парол|секрет|токен|api.?ключ|опубликов|публикац|отправ(ь|ить) (письм|сообщ)/i

export const sensitive = (...texts: ReadonlyArray<string | undefined>) => texts.some((text) => text !== undefined && SENSITIVE.test(text))

/**
 * Whether the Society runs in `auto`. Where no config service exists (tests, embedded hosts) nothing is decided
 * for the operator. A set `observe` or `off` keeps asking; nothing set means `auto`, the operator-facing default.
 */
export const active = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(config)) return false
  const entries = yield* config.value.entries().pipe(Effect.orElseSucceed(() => []))
  const mode = Config.latest(entries, "orchestra")?.society?.autonomy
  return mode === undefined || mode === "auto"
})

/** The index of the option to take: the one marked recommended, else the first. */
export const pick = (labels: ReadonlyArray<string>, recommended?: ReadonlyArray<boolean>) => {
  const marked = labels.findIndex((label, index) => recommended?.[index] === true || /\(recommended\)|рекомендуется/i.test(label))
  return marked >= 0 ? marked : 0
}

export const REASON = "auto mode: the Orchestrator picks the recommended option instead of asking"
