export * as ReconDedup from "./recon-dedup.js"
import { createHash } from "node:crypto"
export const KEY = "orchestra.recon.hashes"
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])) : value
export const digest = (content: unknown) => createHash("sha256").update(JSON.stringify(canonical(typeof content === "string" ? [{type:"text",text:content}] : content))).digest("hex")
export const hashes = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)).slice(0,256) : []
export const duplicate = (content: unknown, supplied: unknown) => hashes(supplied).includes(digest(content))
export const pointer = "This exact file range is unchanged and already attached in the Orchestrator's reconnaissance brief. Use that attached content; request another range if needed."
