import { templateError } from "@orchestra/core/project-template-errors"
import { InvalidRequestError } from "@orchestra/protocol/errors"
import { Effect } from "effect"

type TemplateOperation = "list" | "prepareSave" | "confirmSave" | "prepareCreate" | "confirmCreate" | "finishCreate" | "browsers"

/** Log only the same allowlisted reason sent to the client, never the raw exception or submitted payload. */
export function templateOperation<A>(operation: TemplateOperation, action: () => Promise<A>) {
  return Effect.tryPromise({
    try: action,
    catch: (error) => new InvalidRequestError(templateError(error)),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("project template operation refused", {
        operation,
        kind: error.kind,
        reason: error.message,
      }),
    ),
  )
}
