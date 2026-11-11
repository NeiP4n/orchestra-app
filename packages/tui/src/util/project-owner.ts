import { Orchestra } from "@orchestra/schema/orchestra"

/**
 * The one project a directory belongs to. Projects can be nested (a workspace folder and a plugin inside
 * it), so the most specific directory wins instead of every containing project matching.
 */
export function owningProject<T extends { directory: string }>(
  projects: readonly T[],
  directory: string,
): T | undefined {
  let best: T | undefined
  for (const project of projects) {
    if (!Orchestra.contains(project.directory, directory)) continue
    if (!best || project.directory.length > best.directory.length) best = project
  }
  return best
}
