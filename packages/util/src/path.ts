import { realpathSync } from "node:fs"

export function getFilename(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return trimmed.slice(index + 1)
}

export function getDirectory(path: string | undefined) {
  if (!path) return ""
  const trimmed = path.replace(/[/\\]+$/, "")
  const parts = trimmed.split(/[/\\]/)
  return parts.slice(0, parts.length - 1).join("/") + "/"
}

export function getFilenameTruncated(path: string | undefined, maxLength = 20) {
  const filename = getFilename(path)
  if (filename.length <= maxLength) return filename
  const lastDot = filename.lastIndexOf(".")
  const extension = lastDot <= 0 ? "" : filename.slice(lastDot)
  const available = maxLength - extension.length - 1
  if (available <= 0) return filename.slice(0, maxLength - 1) + "…"
  return filename.slice(0, available) + "…" + extension
}

export function truncateMiddle(text: string, maxLength = 20) {
  if (text.length <= maxLength) return text
  const available = maxLength - 1
  const start = Math.ceil(available / 2)
  const end = Math.floor(available / 2)
  return text.slice(0, start) + "…" + text.slice(-end)
}

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const isWindowsPlatform = typeof process !== "undefined" && process.platform === "win32"

function cleanResolvedPath(resolved: string): string {
  let p = resolved.replaceAll("\\", "/")
  if (p.startsWith("//?/UNC/")) {
    p = "//" + p.slice(8)
  } else if (p.startsWith("//?/")) {
    p = p.slice(4)
  }
  if (p.length > 3 && p.endsWith("/")) {
    p = p.slice(0, -1)
  }
  return p
}

function canonicalizePath(normalized: string, isRelative: boolean): string {
  if (typeof realpathSync !== "function") return normalized

  if (isRelative) {
    if (typeof process === "undefined" || typeof process.cwd !== "function") return normalized
    try {
      const real = cleanResolvedPath(realpathSync.native(normalized))
      const cwd = cleanResolvedPath(process.cwd())
      if (real === cwd) return "."
      if (real.startsWith(cwd + "/")) {
        return real.slice(cwd.length + 1)
      }
    } catch {}
    return normalized
  }

  try {
    return cleanResolvedPath(realpathSync.native(normalized))
  } catch {}

  let cur = normalized
  const trailingSegments: string[] = []

  while (true) {
    const slashIdx = cur.lastIndexOf("/")
    if (slashIdx === -1) break
    const parent = slashIdx === 0 ? "/" : cur.slice(0, slashIdx)
    const segment = cur.slice(slashIdx + 1)
    if (segment) {
      trailingSegments.unshift(segment)
    }
    const probe = /^[a-zA-Z]:$/.test(parent) ? `${parent}/` : parent
    try {
      const realParent = cleanResolvedPath(realpathSync.native(probe))
      const suffix = trailingSegments.join("/")
      const separator = realParent.endsWith("/") ? "" : "/"
      return `${realParent}${separator}${suffix}`
    } catch {
      cur = parent
      if (cur === "/" || /^[a-zA-Z]:\/?$/.test(cur) || (cur.startsWith("//") && cur.split("/").length <= 4)) {
        break
      }
    }
  }

  return normalized
}

/** A comparable form of a directory path: forward slashes for Windows paths, collapsed . and .. segments, no trailing slash except on roots. */
export function comparablePath(path: string) {
  const value = path.includes("\\") ? path.replaceAll("\\", "/") : path
  const isUnc = value.startsWith("//")
  const isAbsoluteUnix = !isUnc && value.startsWith("/")
  const parts = value.split("/")
  const segments: string[] = []

  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (segments.length > 0) {
        if (segments.length === 1 && isDrive(segments[0])) {
          // Do not pop Windows drive letter (e.g. C:/.. remains C:/)
        } else if (segments[segments.length - 1] === "..") {
          segments.push("..")
        } else {
          segments.pop()
        }
      } else if (!isAbsoluteUnix && !isUnc) {
        segments.push("..")
      }
    } else {
      segments.push(part)
    }
  }

  let result: string
  const isDrivePath = segments.length > 0 && isDrive(segments[0])
  const isRelative = !isUnc && !isAbsoluteUnix && !isDrivePath

  if (isUnc) {
    result = "//" + segments.join("/")
  } else if (isAbsoluteUnix) {
    result = "/" + segments.join("/")
  } else if (isDrivePath) {
    result = segments.length === 1 ? `${segments[0]}/` : segments.join("/")
  } else if (segments.length === 0) {
    result = value.startsWith("/") ? "/" : ""
  } else {
    result = segments.join("/")
  }

  const shouldCanonicalize = isWindowsPlatform
    ? isDrivePath || isUnc || isRelative
    : isAbsoluteUnix

  if (shouldCanonicalize && result !== "" && result !== "/") {
    return canonicalizePath(result, isRelative)
  }
  return result
}

/** `child` is `parent` or inside it. Windows drive and UNC paths compare case-insensitively. */
export function containsDirectory(parent: string, child: string) {
  const normalize = (value: string) => {
    const key = comparablePath(value)
    return isWindowsPlatform || /^[a-z]:(\/|$)/i.test(key) || key.startsWith("//")
      ? key.toLowerCase()
      : key
  }
  const root = normalize(parent)
  const target = normalize(child)
  return target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`)
}

export function sameDirectory(a: string, b: string) {
  return containsDirectory(a, b) && containsDirectory(b, a)
}

export function encodeFilePath(filepath: string): string {
  // Normalize Windows paths: convert backslashes to forward slashes
  const normalized = filepath.replace(/\\/g, "/")

  // Handle Windows absolute paths (D:/path -> /D:/path for proper file:// URLs)
  const rooted = /^[A-Za-z]:/.test(normalized) ? "/" + normalized : normalized

  // Encode each path segment (preserving forward slashes as path separators)
  // Keep the colon in Windows drive letters (`/C:/...`) so downstream file URL parsers
  // can reliably detect drives.
  return rooted
    .split("/")
    .map((segment, index) => {
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment
      return encodeURIComponent(segment)
    })
    .join("/")
}
