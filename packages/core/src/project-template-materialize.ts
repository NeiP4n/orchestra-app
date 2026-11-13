export * as ProjectTemplateMaterialize from "./project-template-materialize.js"

import { templateStage, type TemplateStage } from "./project-template-errors.js"
import type { Session } from "@orchestra/schema/session"
import { ProjectTemplateImport } from "./project-template-import.js"

export type Plan = ReturnType<typeof ProjectTemplateImport.prepare>
/** Fixed application-owned process adapter, never supplied by template content. */
export interface ProcessAdapter {
  prepare: (
    serialized: string,
    digest: string,
    projectID: string,
  ) => Promise<{ template: string; process: NonNullable<Receipt["process"]>; roles: ReadonlySet<string> }>
  validate: (receipt: Receipt) => Promise<ReadonlySet<string>>
  ensure: (receipt: Receipt) => Promise<void>
  verify: (receipt: Receipt) => Promise<void>
  metadata: (receipt: Receipt, session: Plan["sessions"][number]) => Session.Metadata
  changed: () => Promise<void>
}
/** These ports are not arbitrary post-import hooks. Each is an idempotent ensure for this
 * receipt's fresh identities, rejects foreign/changed state and never starts an agent/browser.
 * Publication is last. No rollback deletes user-owned state; failure leaves a resumable receipt. */
export interface Ports {
  lock: <T>(id: string, action: () => Promise<T>) => Promise<T>
  readReceipt: (id: string) => Promise<Receipt | undefined>
  createReceipt: (receipt: Receipt) => Promise<void>
  updateReceipt: (receipt: Receipt) => Promise<void>
  ensureDirectory: (receipt: Receipt) => Promise<void>
  ensureProcess?: (receipt: Receipt) => Promise<void>
  verifyProcess?: (receipt: Receipt) => Promise<void>
  ensureSession: (receipt: Receipt, session: Plan["sessions"][number]) => Promise<void>
  ensureRules: (receipt: Receipt, rules: Plan["rules"]) => Promise<void>
  ensureVault: (receipt: Receipt, slots: Plan["localVaultSlots"]) => Promise<void>
  ensureBrowsers: (receipt: Receipt, browsers: Plan["browsers"]) => Promise<void>
  ensureSchedules: (receipt: Receipt, schedules: Plan["schedules"]) => Promise<void>
  verify: (receipt: Receipt) => Promise<void>
  publish: (receipt: Receipt) => Promise<void>
  verifyPublished: (receipt: Receipt) => Promise<void>
}
export const PHASES = [
  "reserved",
  "directory",
  "process",
  "sessions",
  "rules",
  "vault",
  "browsers",
  "schedules",
  "verified",
  "published",
] as const
export interface Receipt {
  version: 1
  createdAt: number
  template: string
  timezone: string
  id: string
  projectID: string
  name: string
  directory: string
  digest: string
  phase: (typeof PHASES)[number]
  plan: Plan
  process?: { version: 2; template: string; digest: string }
}
function same(a: Receipt, b: Receipt) {
  const { phase: _a, ...left } = a,
    { phase: _b, ...right } = b
  return JSON.stringify(left) === JSON.stringify(right)
}
export function make(ports: Ports) {
  return {
    apply: (reservation: Receipt) =>
      ports.lock(reservation.id, async () => {
        if (
          reservation.version !== 1 ||
          (reservation.process !== undefined && (!ports.ensureProcess || !ports.verifyProcess)) ||
          !Number.isFinite(reservation.createdAt) ||
          !/^pti_[A-Za-z0-9_-]{1,100}$/.test(reservation.id) ||
          !/^prj[A-Za-z0-9_-]+$/.test(reservation.projectID) ||
          !reservation.name.trim() ||
          reservation.plan.projectID !== reservation.projectID ||
          reservation.digest !== reservation.plan.digest ||
          !reservation.plan.mainSessionID ||
          reservation.plan.started !== false ||
          reservation.plan.schedules.some(
            (schedule) => schedule.enabled || schedule.publishApproved || schedule.nextAt !== null,
          ) ||
          reservation.plan.localVaultSlots.some((slot) => slot.state !== "empty" || slot.allowedSessionIDs.length)
        )
          throw Error("Invalid inert import reservation.")
        let receipt = await ports.readReceipt(reservation.id)
        if (receipt) {
          if (!same(receipt, reservation) || !PHASES.includes(receipt.phase))
            throw Error("Import receipt differs from the reserved definitions.")
        } else {
          receipt = { ...reservation, phase: "reserved" }
          await ports.createReceipt(receipt)
          const saved = await ports.readReceipt(receipt.id)
          if (!saved || !same(saved, receipt) || saved.phase !== "reserved")
            throw Error("Import reservation did not persist.")
        }
        if (receipt.phase === "published") {
          if (receipt.process) await ports.verifyProcess!(receipt)
          await ports.verifyPublished(receipt)
          return receipt
        }
        const advance = async (phase: Receipt["phase"], action: () => Promise<void>) => {
          if (PHASES.indexOf(receipt!.phase) >= PHASES.indexOf(phase)) return
          const stages: Partial<Record<Receipt["phase"], TemplateStage>> = {
            directory: "base-project",
            process: "process-bindings",
            sessions: "base-sessions",
            rules: "base-rules",
            vault: "base-vault",
            browsers: "base-browsers",
            schedules: "base-schedules",
          }
          await templateStage(stages[phase] ?? "base-project", async () => {
            await action()
            const next = { ...receipt!, phase }
            await ports.updateReceipt(next)
            const saved = await ports.readReceipt(next.id)
            if (!saved || !same(saved, next) || saved.phase !== phase) throw Error("Import checkpoint did not persist.")
            receipt = saved
          })
        }
        await advance("directory", () => ports.ensureDirectory(receipt!))
        if (receipt.process) await advance("process", () => ports.ensureProcess!(receipt!))
        await advance("sessions", async () => {
          for (const session of receipt!.plan.sessions) await ports.ensureSession(receipt!, session)
        })
        await advance("rules", () => ports.ensureRules(receipt!, receipt!.plan.rules))
        await advance("vault", () => ports.ensureVault(receipt!, receipt!.plan.localVaultSlots))
        await advance("browsers", () => ports.ensureBrowsers(receipt!, receipt!.plan.browsers))
        await advance("schedules", () => ports.ensureSchedules(receipt!, receipt!.plan.schedules))
        // Always verify all actual stores on every resumed call, including checkpoints already written.
        if (receipt.process) await templateStage("process-bindings", () => ports.verifyProcess!(receipt!))
        await templateStage("base-project", () => ports.verify(receipt!))
        await advance("verified", async () => {})
        // Crash after publish but before checkpoint is safe only because publish itself is create-only/idempotent.
        await templateStage("base-project", async () => {
          await ports.publish(receipt!)
          await ports.verifyPublished(receipt!)
        })
        await advance("published", async () => {})
        return receipt
      }),
  }
}
