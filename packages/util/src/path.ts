// Namespace import, not a named import: in the browser bundle Vite
// externalizes node:fs to a stub with no named exports, and Rolldown
// fails the build on a missing named export ("realpathSync" is not
// exported by "__vite-browser-external:node:fs") even though the code
// below already guards on typeof realpathSync !== "function". Reading
// the property off the namespace object keeps that guard working in
// the browser (undefined -> normalized path) and real on Node.
import * as nodeFs from "node:fs"

const realpathSync = nodeFs.realpathSync
const lstatSync = nodeFs.lstatSync
const readlinkSync = nodeFs.readlinkSync

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
  // realpath on Windows reports drive or UNC syntax with backslashes; a POSIX
  // realpath can legitimately contain a literal backslash inside a name, so
  // only unambiguous Windows syntax is normalized.
  const windowsForm = /^[a-zA-Z]:([\\/]|$)/.test(resolved) || resolved.startsWith("\\\\")
  let p = windowsForm ? resolved.replaceAll("\\", "/") : resolved
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

  // Backslashes only survive normalization in POSIX-rooted paths, where they
  // are literal name characters. realpath cannot be trusted with such names
  // (Bun before 1.4.3 silently collapses them into separators), so those
  // paths are canonicalized segment by segment instead.
  if (normalized.includes("\\")) return canonicalizePosixLiteral(normalized)

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

// realpath semantics for a POSIX-rooted path that contains literal
// backslashes, without feeding the name to realpath: one remaining-segments
// queue plus a resolved prefix, walked with lstat/readlink (which handle such
// names correctly on every runtime). Symlink targets expand INTO the queue,
// so every segment resolves in filesystem order under a single hop budget and
// a ".." only ever applies to an already-resolved prefix. The result is
// best-effort, not an authorization boundary. Missing-tail contract: only
// ENOENT keeps a lexical tail under the resolved prefix, and a ".." that
// climbs out of the missing suffix makes the whole input stay unresolved;
// other errors and hop exhaustion return the input unresolved as well.
// TOCTOU: the result is a string identity at walk time, not an access
// handle; a later filesystem change is not reflected.
function canonicalizePosixLiteral(normalized: string): string {
  if (typeof lstatSync !== "function" || typeof readlinkSync !== "function") return normalized
  const queue = normalized.split("/")
  const resolved: string[] = []
  let hops = 0
  for (let i = 0; i < queue.length; i++) {
    const segment = queue[i]
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      resolved.pop()
      continue
    }
    const candidate = `/${[...resolved, segment].join("/")}`
    let stat: ReturnType<typeof nodeFs.lstatSync>
    try {
      stat = lstatSync(candidate)
    } catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") {
        // Proper nonexistence: collapse the missing tail lexically against the
        // resolved prefix. A ".." that climbs out of the missing suffix back
        // to the resolved prefix invalidates any canonical claim for what
        // follows (a sibling there could be a symlink; native realpath would
        // report ENOENT for the whole path), so the input stays unresolved.
        const tail = [...resolved]
        for (const part of queue.slice(i)) {
          if (part === "" || part === ".") continue
          if (part === "..") {
            if (tail.length <= resolved.length + 1) return normalized
            tail.pop()
            continue
          }
          tail.push(part)
        }
        return "/" + tail.join("/")
      }
      return normalized
    }
    if (!stat.isSymbolicLink()) {
      resolved.push(segment)
      continue
    }
    if (hops >= 40) return normalized
    hops += 1
    let target: string
    try {
      target = readlinkSync(candidate)
    } catch {
      return normalized
    }
    const absolute = target.startsWith("/") ? target : `/${[...resolved, target].join("/")}`
    const rest = queue.slice(i + 1)
    queue.length = 0
    queue.push(...absolute.split("/"), ...rest)
    resolved.length = 0
    i = -1
  }
  return "/" + resolved.join("/")
}

// Exactly two leading slashes followed by a non-slash name is UNC syntax; a
// run of three or more slashes (or slashes only) is a POSIX root.
const hasUncSyntax = (value: string) => value.startsWith("//") && value.length > 2 && value[2] !== "/"

// A path rooted at a single slash with no drive or UNC syntax is POSIX, so a
// backslash inside it is a literal name character, not a separator. Every
// other shape (drive, UNC, or relative) keeps treating backslashes as Windows
// separators.
const isPosixRooted = (value: string) => value.startsWith("/") && !hasUncSyntax(value)

/** A comparable form of a directory path: forward slashes for Windows paths, collapsed . and .. segments, no trailing slash except on roots. */
export function comparablePath(path: string) {
  // On win32 a slash-rooted path is valid current-drive syntax, so the
  // literal-backslash reading only applies off Windows.
  const posixLiteral = !isWindowsPlatform && isPosixRooted(path)
  // A ".." after a backslash-named symlink must apply to the link's resolved
  // target, so raw POSIX-literal input goes through the segment walker before
  // the generic lexical ".." collapse below can erase the pair. (For paths
  // without literal backslashes that same symlink-vs-".." ordering remains a
  // known limitation of the lexical pre-collapse.)
  if (
    posixLiteral &&
    path.includes("\\") &&
    typeof lstatSync === "function" &&
    typeof readlinkSync === "function"
  ) {
    return canonicalizePosixLiteral(path)
  }
  const value = posixLiteral ? path : path.includes("\\") ? path.replaceAll("\\", "/") : path
  const isUnc = hasUncSyntax(value)
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
