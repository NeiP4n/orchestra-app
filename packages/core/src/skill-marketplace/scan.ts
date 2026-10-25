export * as SkillMarketplaceScan from "./scan.js"

/**
 * A native static scan of a skill's text, modelled on NVIDIA SkillSpector's first stage
 * (https://github.com/NVIDIA/skillspector): regex rules grouped by threat category, a severity per
 * rule, and a 0-100 risk score that maps onto SAFE / CAUTION / DO NOT INSTALL.
 *
 * What it does not do: run the skill, call a model, look up dependency CVEs, or read files other
 * than the `SKILL.md` it is handed (the catalog serves nothing else). A clean scan therefore means
 * "no known bad pattern in the text", never "safe", and the answer says so.
 */

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
export type Recommendation = "SAFE" | "CAUTION" | "DO NOT INSTALL"

export interface Finding {
  readonly rule: string
  readonly category: string
  readonly severity: Severity
  readonly line: number
  readonly excerpt: string
  readonly message: string
}

export interface Report {
  readonly score: number
  readonly recommendation: Recommendation
  readonly findings: Finding[]
}

/** SkillSpector's weights: one finding of each severity adds this many points to the score. */
const POINTS: Record<Severity, number> = { CRITICAL: 50, HIGH: 25, MEDIUM: 10, LOW: 5 }
const EXCERPT_LIMIT = 120

interface Rule {
  readonly id: string
  readonly category: string
  readonly severity: Severity
  readonly pattern: RegExp
  readonly message: string
}

const rule = (id: string, category: string, severity: Severity, pattern: RegExp, message: string): Rule => ({
  id,
  category,
  severity,
  pattern,
  message,
})

const RULES: readonly Rule[] = [
  rule("PI-001", "prompt-injection", "CRITICAL", /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts)/i, "Tries to override the instructions the agent already has."),
  rule("PI-002", "prompt-injection", "HIGH", /(do\s+not|don'?t|never)\s+(tell|inform|show|mention)[^.\n]{0,40}\b(user|human)\b/i, "Asks the agent to hide its actions from the user."),
  rule("PI-003", "prompt-injection", "HIGH", /<!--[^>]*(ignore|instruction|system|secret|you must)[^>]*-->/i, "Instruction hidden inside an HTML comment."),
  rule("PI-004", "prompt-injection", "HIGH", /[​-‏⁠⁦-⁩\u{e0000}-\u{e007f}]/u, "Invisible Unicode characters that can carry hidden text."),
  rule("AR-001", "anti-refusal", "HIGH", /(never|do\s+not|don'?t)\s+(refuse|decline|add\s+(any\s+)?(disclaimers?|warnings?))/i, "Tries to suppress refusals or safety warnings."),
  rule("AR-002", "anti-refusal", "HIGH", /\b(jailbreak|DAN\s+mode|developer\s+mode\s+enabled|no\s+restrictions)\b/i, "Jailbreak framing."),
  rule("DE-001", "data-exfiltration", "CRITICAL", /(curl|wget|fetch|Invoke-WebRequest|iwr)\b[^\n]{0,120}(\$\{?(\w*(KEY|TOKEN|SECRET|PASSWORD)\w*)|\.env\b|id_rsa|\.aws\/credentials)/i, "Sends secrets or credential files to a remote host."),
  rule("DE-002", "data-exfiltration", "HIGH", /\b(printenv|env|set|Get-ChildItem\s+env:)\b\s*\|\s*(curl|nc|wget|base64)/i, "Pipes the environment to a network or encoding tool."),
  rule("DE-003", "data-exfiltration", "HIGH", /(~|\$HOME|%USERPROFILE%)[\\/]\.(ssh|aws|gnupg|config[\\/]gcloud|npmrc|netrc)|\bid_(rsa|ed25519)\b|\.aws[\\/]credentials/i, "Reads credential locations."),
  rule("DE-004", "data-exfiltration", "MEDIUM", /(send|post|upload|exfiltrate)[^.\n]{0,60}\b(conversation|chat\s+history|context|system\s+prompt)\b[^.\n]{0,40}\b(to|at)\b\s+https?:/i, "Sends the conversation to a remote host."),
  rule("PE-001", "privilege-escalation", "HIGH", /\bsudo\b|\brunas\b|\bchmod\s+(-R\s+)?[0-7]?777\b|\bchown\s+root\b/i, "Escalates privileges or opens permissions."),
  rule("PE-002", "privilege-escalation", "CRITICAL", /\brm\s+-rf?\s+(\/|~|\$HOME|\*)(\s|$)|\bformat\s+[a-z]:|\bdel\s+\/s\s+\/q\s+[a-z]:\\/i, "Destructive delete of a root, home or drive."),
  rule("SC-001", "supply-chain", "CRITICAL", /(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]{0,160}\|\s*(sudo\s+)?(ba|z|da)?sh\b|\|\s*iex\b/i, "Downloads a script and runs it without review."),
  rule("SC-002", "supply-chain", "HIGH", /base64\s+(-d|--decode)[^\n]{0,60}\|\s*(ba|z)?sh\b|\bFromBase64String\b[^\n]{0,80}\b(iex|Invoke-Expression)\b/i, "Decodes and runs obfuscated code."),
  rule("SC-003", "supply-chain", "MEDIUM", /\b(npx|bunx)\s+(-y|--yes)\s+[^\s@]+(\s|$)|\bpip3?\s+install\s+(?!-r)[a-z0-9_.-]+\s*($|\n|`)/i, "Installs a package without pinning a version."),
  rule("EA-001", "excessive-agency", "HIGH", /--dangerously-skip-permissions|bypass(ing)?\s+(the\s+)?(permission|approval|sandbox)|auto[- ]?approve\s+(all|every)/i, "Asks the agent to bypass permission checks."),
  rule("EA-002", "excessive-agency", "MEDIUM", /allowed-tools\s*:\s*\[?\s*["']?\*|tools\s*:\s*\*\s*$/im, "Requests unrestricted tool access."),
  rule("SL-001", "system-prompt-leakage", "HIGH", /(reveal|print|output|repeat|show)\s+(your|the)\s+(full\s+)?(system\s+prompt|hidden\s+instructions|initial\s+instructions)/i, "Asks for the system prompt."),
  rule("MP-001", "memory-poisoning", "HIGH", /(append|write|add|save)[^.\n]{0,60}\b(CLAUDE\.md|AGENTS\.md|\.cursorrules|memory\s+file|MEMORY\.md)\b/i, "Writes into the agent's persistent instructions or memory."),
  rule("RA-001", "rogue-agent", "HIGH", /\b(crontab|schtasks|launchctl|systemctl\s+enable|New-ScheduledTask)\b|\.bashrc|\.zshrc|\.profile\b|CurrentVersion[\\/]Run/i, "Sets up persistence outside the session."),
  rule("RA-002", "rogue-agent", "CRITICAL", /(modify|edit|rewrite|overwrite|update)\s+(this|its\s+own|your\s+own)\s+(skill|SKILL\.md|instructions)/i, "Self-modification."),
  rule("TA-001", "trigger-abuse", "MEDIUM", /(always|automatically)\s+(use|run|invoke|load)\s+this\s+skill|for\s+(every|any|all)\s+(task|request|prompt|message)/i, "Trigger so broad it shadows other skills."),
  rule("BA-001", "behavioral", "CRITICAL", /\b(eval|exec)\s*\(|\bos\.system\s*\(|\bsubprocess\.[a-z_]+\([^)\n]*shell\s*=\s*True|\bchild_process\b[^\n]{0,40}\bexec(Sync)?\(|\bnew\s+Function\s*\(/, "Dynamic code execution in a code sample."),
  rule("BA-002", "behavioral", "MEDIUM", /\b(subprocess\.(run|call|Popen|check_output)|Bun\.spawn|spawnSync?)\s*\(/, "Spawns a process."),
  rule("MW-001", "malware", "CRITICAL", /\bxmrig\b|stratum\+tcp:\/\/|\/dev\/tcp\/|\bnc(at)?\s+(-\w*e\w*|--exec)\b|bash\s+-i\s+>&|\bmimikatz\b|\bmeterpreter\b/i, "Miner, reverse shell or hack-tool signature."),
]

/** A line this long is data, not prose; one match inside it would otherwise print a screenful. */
const clip = (line: string) => {
  const flat = line.trim().replace(/\s+/g, " ")
  return flat.length <= EXCERPT_LIMIT ? flat : `${flat.slice(0, EXCERPT_LIMIT - 1)}…`
}

const recommend = (score: number): Recommendation => (score <= 20 ? "SAFE" : score <= 50 ? "CAUTION" : "DO NOT INSTALL")

/**
 * Scans text line by line, so every finding names the line a human can open. One rule counts once
 * per skill however many lines match it: a skill repeating the same pattern twenty times is not
 * twenty times as dangerous, and the score would otherwise saturate on repetition alone.
 */
export const scan = (content: string): Report => {
  const lines = content.split(/\r?\n/)
  const findings = RULES.flatMap((entry) => {
    const index = lines.findIndex((line) => entry.pattern.test(line))
    if (index === -1) return []
    return [
      {
        rule: entry.id,
        category: entry.category,
        severity: entry.severity,
        line: index + 1,
        excerpt: clip(lines[index] ?? ""),
        message: entry.message,
      } satisfies Finding,
    ]
  })
  const score = Math.min(
    100,
    findings.reduce((total, finding) => total + POINTS[finding.severity], 0),
  )
  return { score, recommendation: recommend(score), findings }
}

/** True when the report says the skill must not be put where the agent will load it. */
export const blocked = (report: Report) => report.recommendation === "DO NOT INSTALL"
