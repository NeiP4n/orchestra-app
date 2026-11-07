import type { DiscoverOptions } from "./service.js"

// A version is `release+build`: the release (`1.0.0`) is the protocol the
// client and server speak, while the build (`+a3727276a`, the checkout commit)
// only says which sources produced the binary. Semver ignores build metadata
// when ordering versions, and a server must not be restarted merely because
// the client was rebuilt from a newer commit of the same release — that
// restart costs a full cold start after every `git pull`. Compare releases,
// not builds. A different release still replaces the server.
export function matchesVersion(version: string | undefined, options: DiscoverOptions) {
  if (options.version === undefined) return true
  if (version === undefined) return false
  if (typeof options.version === "function") return options.version(version)
  return releaseOf(version) === releaseOf(options.version)
}

function releaseOf(version: string) {
  const plus = version.indexOf("+")
  return plus === -1 ? version : version.slice(0, plus)
}
