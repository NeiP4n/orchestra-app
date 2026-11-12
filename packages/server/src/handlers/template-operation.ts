import { templateError, templateDiagnosticOf } from "@orchestra/core/project-template-errors"
import { InvalidRequestError } from "@orchestra/protocol/errors"
import { Effect } from "effect"

type TemplateOperation = "remove" | "exportFile" | "prepareImport" | "confirmImport" | "list" | "prepareSave" | "confirmSave" | "prepareCreate" | "confirmCreate" | "finishCreate" | "browsers"

/** Log only the same allowlisted reason sent to the client, never the raw exception or submitted payload. */
export function templateOperation<A>(operation: TemplateOperation, action: () => Promise<A>) {
  return Effect.tryPromise({
    try: action,
    catch: (error) => ({ response: new InvalidRequestError(templateError(error)), diagnostic: templateDiagnosticOf(error) }),
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("project template operation refused", {
        operation,
        kind: error.response.kind,
        reason: error.response.message,
        ...(error.diagnostic ?? {}),
      }),
    ),
    Effect.mapError(error => error.response),
  )
}
