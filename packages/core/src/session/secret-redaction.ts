const REDACTED = "[redacted]"

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private keys, whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  // Well-known token shapes.
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,})\b/g, REDACTED],
  // Authorization headers keep the scheme, lose the credential.
  [/((?:Authorization|Proxy-Authorization)["']?\s*:\s*["']?(?:Bearer|Basic|Token)\s+)[^\s"']+/gi, `$1${REDACTED}`],
  // Credentials embedded in a URL keep the user, lose the password.
  [/((?:https?|wss?):\/\/[^\s/:@]+:)[^@\s/]+@/gi, `$1${REDACTED}@`],
  // key=value / key: value assignments. The key stays so the shape of the text survives.
  [
    /((?:api[_-]?key|apikey|password|passwd|pwd|secret|token|auth|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
    `$1${REDACTED}`,
  ],
]

/** The text with anything that looks like a credential replaced by [redacted]. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text)
}
