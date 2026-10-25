/** Whether a directory listing holds `.github`. The server marks directories with a trailing path separator. */
export function hasGithubDirectory(entries: readonly { path: string; type: "file" | "directory" }[]) {
  return entries.some((entry) => entry.type === "directory" && entry.path.replace(/[\\/]+$/, "") === ".github")
}
