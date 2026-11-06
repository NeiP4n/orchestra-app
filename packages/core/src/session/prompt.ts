export * as SessionPrompt from "./prompt.js"

import { Base64, FileAttachment, Prompt } from "@orchestra/schema/prompt"
import { PromptInput } from "@orchestra/schema/prompt-input"
import { SessionInbox } from "@orchestra/schema/session-inbox"
import type { Session } from "@orchestra/schema/session"
import type { SessionMessage } from "@orchestra/schema/session-message"
import { FSUtil } from "@orchestra/util/fs-util"
import { Effect, Option } from "effect"
import path from "path"
import { fileURLToPath } from "url"
import { Autoloop } from "../autoloop/service.js"
import { Dod } from "../dod.js"
import { Image } from "../image.js"
import { Instance } from "../instance/service.js"
import { Location } from "../location.js"
import { Mime } from "../mime.js"
import { Plugin } from "../plugin/service.js"
import { PluginHooks } from "../plugin/hooks.js"
import { PromptIntake } from "../prompt-intake/index.js"
import { Skill } from "../skill.js"
import { AttachmentError, SkillNotFoundError } from "./error.js"
import { SessionStore } from "./store.js"

export type Input = {
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  metadata?: Record<string, unknown>
  delivery?: SessionInbox.Delivery
  resume?: boolean
  /**
   * Who sent the prompt. `"user"` is a human (HTTP prompt endpoints pass
   * it); anything sent by an agent — orchestrator dispatches, subagents,
   * forge runs, `sessions` tool calls — passes nothing and defaults to
   * `"agent"`. Only `"user"` prompts are ever refused by the value verdict:
   * a dispatch restating a board item IS the work, not a duplicate of it.
   */
  origin?: "user" | "agent"
}

export const prepare = Effect.fn("SessionPrompt.prepare")(function* (request: {
  session: Session.Info
  messageID: SessionMessage.ID
  input: Input
}) {
  const fs = yield* FSUtil.Service
  const instances = yield* Instance.Service

  return yield* Effect.gen(function* () {
    yield* Plugin.awaitActivation
    const hooks = yield* PluginHooks.Service
    const event = yield* hooks.trigger("session", "prompt", {
      sessionID: request.session.id,
      messageID: request.messageID,
      prompt: structuredClone({
        text: request.input.text,
        files: request.input.files?.slice(),
        agents: request.input.agents?.slice(),
        skills: request.input.skills?.slice(),
      }),
      metadata: structuredClone(request.input.metadata),
      delivery: request.input.delivery ?? "steer",
    })
    const input = event.prompt
    // Deep-process the prompt before the agent sees it: value check, structured
    // task, recommended skills. Best-effort — a failure here never blocks
    // admission, the raw prompt goes through untouched.
    const intake = yield* runPromptIntake({ session: request.session, text: input.text })
    // A refusal verdict is policy, not a hint: for a prompt that came from a
    // human, nothing is admitted and no drain starts — the reason goes back
    // to the sender through PromptInput.Rejected, the channel the session
    // prompt hook already uses to refuse a prompt before it is enqueued.
    // This runs before attachments are materialized and skills are selected,
    // so a refused prompt costs no work at all. Agent-origin prompts are
    // never refused (see Input.origin).
    if (intake?.disposition.action === "refuse" && request.input.origin === "user")
      return yield* new PromptInput.Rejected({
        reason: intake.disposition.reason,
        source: "prompt-intake:value-check",
      })
    const files = input.files
      ? yield* Effect.forEach(input.files, materializeAttachment, { concurrency: 8 })
      : undefined
    const requested = input.skills
    const selected = yield* Effect.gen(function* () {
      if (!requested?.length) return undefined
      const skillService = yield* Skill.Service
      const prepared = new Map<Skill.ID, Skill.Name>()
      return yield* Effect.forEach(requested, (attachment) =>
        Effect.gen(function* () {
          const name = prepared.get(attachment.id)
          if (name !== undefined) return { id: attachment.id, name, mention: attachment.mention }
          const skill = yield* skillService.get(attachment.id)
          if (!skill) return yield* new SkillNotFoundError({ skill: attachment.id })
          prepared.set(skill.id, skill.name)
          return {
            id: skill.id,
            name: skill.name,
            text: (yield* Skill.prepare(fs, skill).pipe(Effect.orDie)).output,
            mention: attachment.mention,
          }
        }),
      )
    })
    return {
      type: "user",
      payload: SessionInbox.UserPayload.make({
        ...Prompt.make({
          text: intake?.enrichedPrompt ?? input.text,
          agents: input.agents,
          files,
          skills: selected?.length ? selected : undefined,
        }),
        metadata: intake
          ? {
              ...event.metadata,
              intake: {
                verdict: intake.value.verdict,
                valueVerdict: intake.valueVerdict,
                goal: intake.task.goal,
                questions: intake.value.questions,
                skills: intake.skills.map((skill) => skill.id),
                modelUsed: intake.modelUsed,
              },
            }
          : event.metadata,
        resumeOnStart: request.input.resume !== false,
      }),
      delivery: SessionInbox.Delivery.make(event.delivery),
    } satisfies SessionInbox.Item
  }).pipe(instances.provide(request.session))
})

/**
 * Runs the prompt intake for one incoming user prompt. Gathers the value
 * checker's sources from what this scope can reach (DoD, recent user
 * prompts in this session, autoloop journal titles) and hands the prompt
 * to the intake service when it is wired, else to the pure pipeline.
 * Returns undefined on any failure: admission must never depend on it.
 */
const runPromptIntake = Effect.fn("SessionPrompt.intake")(function* (input: {
  session: Session.Info
  text: string
}) {
  return yield* Effect.gen(function* () {
    const location = yield* Effect.serviceOption(Location.Service)
    const store = yield* Effect.serviceOption(SessionStore.Service)
    const autoloop = yield* Effect.serviceOption(Autoloop.Service)
    const intakeService = yield* Effect.serviceOption(PromptIntake.Service)

    let dodItems: Array<PromptIntake.DodItemRef> = []
    let dodAvailable = false
    if (Option.isSome(location)) {
      // Effect.option wraps the result in an Option: unwrap it before
      // reading it. The old code read `.type` off the Option itself, so the
      // DoD source never reported "ready" and no DoD item was ever compared.
      const status = yield* Dod.status(location.value.project.directory).pipe(Effect.option)
      if (Option.isSome(status) && status.value.type === "ready") {
        dodAvailable = true
        dodItems = status.value.items.map((item) => ({ id: item.id, title: item.what, state: item.state }))
      }
    }

    let recentPrompts: Array<PromptIntake.RecentPromptRef> = []
    let historyAvailable = false
    if (Option.isSome(store)) {
      // Same unwrap: `messages` is an Option of the list, not the list.
      // The old code called `.filter` on the Option, which threw on every
      // prompt and killed the whole intake (the outer catch fell back to
      // the raw prompt), so the value check never ran at all.
      const messages = yield* store.value
        .messages({ sessionID: input.session.id, limit: 10, order: "desc", type: "user" })
        .pipe(Effect.option)
      if (Option.isSome(messages)) {
        historyAvailable = true
        recentPrompts = messages.value
          .filter((message) => message.type === "user")
          .map((message) => ({ text: message.text }))
      }
    }

    let journalTitles: Array<PromptIntake.JournalRef> = []
    let journalAvailable = false
    if (Option.isSome(autoloop)) {
      // Same unwrap: the old code passed the Option itself to
      // journalTitlesFromView, which read no titles from it.
      const view = yield* autoloop.value.getView().pipe(Effect.option)
      if (Option.isSome(view)) {
        journalAvailable = true
        journalTitles = journalTitlesFromView(view.value)
      }
    }

    const context: PromptIntake.IntakeContext = {
      dodItems,
      recentPrompts,
      journalTitles,
      sources: { dod: dodAvailable, history: historyAvailable, journal: journalAvailable },
    }
    if (Option.isSome(intakeService)) {
      return yield* intakeService.value.process({
        session: input.session,
        text: input.text,
        context,
        disambiguate: PromptIntake.disambiguateWithModel,
      })
    }
    return PromptIntake.processPure({ text: input.text, context })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("prompt intake failed, continuing with raw prompt", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
})

// Titles of autoloop cards and runs, for the duplicate check. The view is
// an untyped record of collections, so only rows with a string title count.
function journalTitlesFromView(view: Record<string, Record<string, unknown>>): Array<PromptIntake.JournalRef> {
  const titles: Array<PromptIntake.JournalRef> = []
  for (const collection of ["cards", "runs"]) {
    for (const row of Object.values(view[collection] ?? {})) {
      if (typeof row !== "object" || row === null) continue
      const data = row as Record<string, unknown>
      if (typeof data.title !== "string") continue
      titles.push({
        title: data.title,
        outcome:
          typeof data.outcome === "string"
            ? data.outcome
            : typeof data.state === "string"
              ? data.state
              : undefined,
      })
    }
  }
  return titles.slice(0, 20)
}

const materializeAttachment = Effect.fn("SessionPrompt.materializeAttachment")(function* (
  input: PromptInput.FileAttachment,
) {
  const label = attachmentLabel(input)
  const resolved = input.uri.startsWith("data:")
    ? {
        bytes: yield* decodeDataURL(input.uri, label),
        source: { type: "inline" as const },
        start: undefined,
        end: undefined,
        name: undefined,
        mime: undefined,
      }
    : yield* readFileAttachment(input.uri)
  if (resolved.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri: label,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${label}`,
    })

  const mime = resolved.mime ?? Mime.detect(resolved.bytes)
  const content =
    mime === "text/plain" && resolved.start !== undefined
      ? Buffer.from(
          Buffer.from(resolved.bytes)
            .toString("utf8")
            .split("\n")
            .slice(resolved.start - 1, resolved.end)
            .join("\n"),
        )
      : resolved.bytes
  const normalized = yield* normalizeImageAttachment(input, Buffer.from(content).toString("base64"), mime)
  return FileAttachment.create({
    data: normalized.data,
    mime: normalized.mime,
    source: resolved.source,
    name: input.name ?? resolved.name,
    description: input.description,
    mention: input.mention,
  })
})

const normalizeImageAttachment = Effect.fn("SessionPrompt.normalizeImageAttachment")(function* (
  input: PromptInput.FileAttachment,
  data: string,
  mime: string,
) {
  if (!mime.startsWith("image/")) return { data: Base64.make(data), mime }
  const image = yield* Image.Service
  const label = attachmentLabel(input)
  const content = { uri: label, content: data, encoding: "base64" as const, mime }
  const normalized = yield* image.normalize(label, content).pipe(
    Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
    Effect.mapError((error) => new AttachmentError({ uri: label, message: error.message })),
  )
  return { data: Base64.make(normalized.content), mime: normalized.mime }
})

const readFileAttachment = Effect.fn("SessionPrompt.readFileAttachment")(function* (uri: string) {
  const fs = yield* FSUtil.Service
  const url = yield* Effect.try({
    try: () => new URL(uri),
    catch: () => new AttachmentError({ uri, message: `Invalid attachment URI: ${uri}` }),
  })
  if (url.protocol !== "file:")
    return yield* new AttachmentError({ uri, message: `Unsupported attachment URI: ${uri}` })
  const start = positiveInt(url.searchParams.get("start"))
  const end = positiveInt(url.searchParams.get("end"))
  const target = yield* Effect.try({
    try: () => {
      url.search = ""
      url.hash = ""
      return fileURLToPath(url)
    },
    catch: () => new AttachmentError({ uri, message: `Invalid file URI: ${uri}` }),
  })
  const info = yield* fs
    .stat(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  if (info.type === "Directory") {
    const entries = yield* fs
      .readDirectoryEntries(target)
      .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
    return {
      bytes: Buffer.from(
        entries
          .filter((entry) => entry.type === "file" || entry.type === "directory")
          .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
          .map((entry) => entry.name + (entry.type === "directory" ? path.sep : ""))
          .join("\n"),
      ),
      source: { type: "uri" as const, uri },
      start: undefined,
      end: undefined,
      name: path.basename(target),
      mime: "application/x-directory",
    }
  }
  if (info.type !== "File") return yield* new AttachmentError({ uri, message: `Attachment is not a file: ${uri}` })
  if (Number(info.size) > MAX_ATTACHMENT_BYTES)
    return yield* new AttachmentError({
      uri,
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${uri}`,
    })
  const bytes = yield* fs
    .readFile(target)
    .pipe(Effect.mapError(() => new AttachmentError({ uri, message: `Unable to read attachment: ${uri}` })))
  return { bytes, source: { type: "uri" as const, uri }, start, end, name: path.basename(target), mime: undefined }
})

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

// A data URL is the whole file; errors and logs must name the attachment, not echo its bytes.
function attachmentLabel(input: PromptInput.FileAttachment) {
  return input.name ?? (input.uri.startsWith("data:") ? "inline attachment" : input.uri)
}

function decodeDataURL(uri: string, label: string) {
  return Effect.try({
    try: () => {
      const comma = uri.indexOf(",")
      if (comma === -1) throw new Error("Invalid data URL")
      const metadata = uri.slice(5, comma)
      const payload = uri.slice(comma + 1)
      if (!metadata.split(";").some((part) => part.toLowerCase() === "base64"))
        return Buffer.from(decodeURIComponent(payload))
      const bytes = Buffer.from(payload, "base64")
      if (bytes.toString("base64") !== payload) throw new Error("Non-canonical base64")
      return bytes
    },
    catch: () => new AttachmentError({ uri: label, message: `Invalid attachment data URL: ${label}` }),
  })
}

function positiveInt(value: string | null) {
  if (value === null) return
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
