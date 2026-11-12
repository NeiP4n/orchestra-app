export * as ShellInPlacePaths from "./in-place-paths.js"

import path from "node:path"
import { ShellScan } from "./scan.js"
import { ShellSelect } from "./select.js"

/** Literal operands of known in-place editors, not a sandbox for arbitrary code.
 * Dynamic/opaque commands retain existing scanner and permission restrictions. */
export function targets(command: string, shell: string, cwd: string): string[] {
  const powershell = ShellSelect.ps(shell)
  const scanned = powershell ? ShellScan.scanPowerShell(command) : ShellScan.scan(command, "posix")
  if (scanned.kind !== "scanned") return []
  const found: string[] = []
  for (const item of scanned.commands) {
    const name = path.basename(item.words[0] ?? "").toLowerCase()
    const sed = name === "sed" && item.words.some(word => word === "--in-place" || word.startsWith("--in-place=") || /^-[^-]*i/.test(word))
    const content = powershell && ["set-content", "add-content", "out-file"].includes(name)
    if (!sed && !content) continue
    let scriptSeen = !sed
    let scriptNext = false
    let pathNext = false
    let positionalSeen = false
    for (let i = 1; i < item.words.length; i++) {
      const word = item.words[i]!
      const raw = item.rawWords[i] ?? ""
      if (sed) {
        if (scriptNext) { scriptNext = false; scriptSeen = true; continue }
        if (word === "-e" || word === "--expression" || word === "-f" || word === "--file") { scriptNext = true; continue }
        if (/^-(?:e|f).+/.test(word) || word.startsWith("--expression=") || word.startsWith("--file=")) { scriptSeen = true; continue }
        if (word.startsWith("-")) continue
        if (!scriptSeen) { scriptSeen = true; continue }
      } else {
        if (["-path", "-literalpath", "-filepath"].includes(word.toLowerCase())) { pathNext = true; continue }
        if (word.startsWith("-")) continue
        if (!pathNext && positionalSeen) continue
        positionalSeen = true
        pathNext = false
      }
      // Unknown shell expansions never become invented filenames.
      if (/[$`]/.test(raw)) continue
      if (!(path.isAbsolute(word) || word.startsWith("./") || word.startsWith("../") || word.startsWith(".\\") || word.startsWith("..\\"))) continue
      found.push(path.resolve(cwd, word))
    }
  }
  return [...new Set(found)]
}
