/**
 * Secret scrubber (Б17 slice 1, gate — §7 risk 2 of the claude-mem draft).
 *
 * Automatic redaction BEFORE any write to memory, journal or files. A
 * `<private>` tag is NOT accepted as protection: agents forget tags, so the
 * scrubber runs on the text itself, at the single write point of each store
 * (`MemoryEngine.remember`/`link`, `Memory` blocks/archive, `Journal.recordError`).
 *
 * Fail-closed by design: a labelled value (`api_key=...`, `password: ...`)
 * is redacted even when the vendor format is unknown, so Anymodel/lix keys
 * are caught by their label as well as by their prefix. Benign prose that
 * merely mentions a secret word ("the secret sauce", "my password is
 * hunter2" with no `:`/`=`) is left alone — the labelled pattern needs the
 * separator. `scrubText` is idempotent: scrubbing twice gives the same text.
 */

export const REDACTED = "[REDACTED]"

/** A pattern plus how its match is replaced. `keepLabel` keeps the `key=` part. */
interface Rule {
  readonly pattern: RegExp
  readonly keepLabel?: boolean
}

const RULES: ReadonlyArray<Rule> = [
  // Whole PEM/PGP private-key blocks, including every line between the markers.
  { pattern: /-----BEGIN (?:[A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]*)PRIVATE KEY-----/g },
  // JWT (header.payload.signature, base64url).
  { pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // Bearer tokens.
  { pattern: /\bBearer\s+[A-Za-z0-9._\-~+/=]{8,}/g },
  // OpenAI-style keys: sk-..., sk-ant-..., sk-proj-..., sk-or-v1-....
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g },
  // GitHub personal / OAuth / server-to-server tokens.
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}/g },
  // Slack tokens.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  // AWS access key id.
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Anymodel / lix keys by vendor prefix. The exact vendor formats are not
  // published anywhere in the repo, so the prefix rule only catches the
  // `prefix-<long-secret>` shape; the labelled rule below catches the rest.
  { pattern: /\b(?:anymodel|am)[-_][A-Za-z0-9]{16,}/g },
  { pattern: /\blix[-_][A-Za-z0-9]{16,}/g },
  // URLs carrying credentials: https://user:password@host keeps the user.
  { pattern: /:\/\/([^\s/:@]+):[^\s/@]+@/g },
  // Labelled secrets: api_key=..., password: "...", token=..., secret: ....
  // The label is kept so the reader still sees WHICH secret was there.
  // Bare `key` is included (it catches `lix_key:` / `refresh_token:` style
  // labels); the lookbehind keeps it from firing mid-word (`turkey:` is
  // not a secret, `lix_key:` is — `_` is not a letter, so it passes).
  {
    pattern:
      /(?<![A-Za-z0-9])((?:api[_-]?key|apikey|key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd|token)\s*[:=]\s*)['"]?[^\s'";,}]{4,}['"]?/gi,
    keepLabel: true,
  },
]

/** Redacted text plus how many secrets were removed. */
export interface ScrubResult {
  readonly text: string
  readonly redacted: number
}

export function scrubSecrets(text: string): ScrubResult {
  let redacted = 0
  let out = text
  for (const rule of RULES) {
    // A shared RegExp keeps its lastIndex between calls; reset it so the
    // same rule scrubs every input from the start.
    rule.pattern.lastIndex = 0
    out = out.replace(rule.pattern, (match, label?: string) => {
      redacted++
      if (rule.keepLabel && label !== undefined) return `${label}${REDACTED}`
      if (match.startsWith("://")) {
        // URL rule: the capture is the user, the password is dropped.
        const user = match.slice(3, match.indexOf(":", 3))
        return `://${user}:${REDACTED}@`
      }
      return REDACTED
    })
  }
  return { text: out, redacted }
}

/** Redact every secret in `text`. Idempotent. */
export function scrubText(text: string): string {
  return scrubSecrets(text).text
}

/** How many secrets `scrubText` would remove from `text`. */
export function countSecrets(text: string): number {
  return scrubSecrets(text).redacted
}

/**
 * Recursively redact secrets inside an unknown value (strings, arrays,
 * plain objects). Anything else passes through untouched, so metadata keeps
 * its shape and numbers/booleans/null survive the scrub.
 */
export function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value)
  if (Array.isArray(value)) return value.map((item) => scrubValue(item))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubValue(item)]))
  }
  return value
}
