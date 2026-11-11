import type { Config, Path, Project, ProviderAuthResponse } from "@/runtime/server/types"
import type { LocationGetInput, LocationGetOutput, ProjectListOutput } from "@orchestra/client/promise"
import { showToast } from "@/shell/notifications/toast"
import { getFilename } from "@orchestra/util/path"
import { retry } from "@orchestra/util/retry"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State } from "./types"
import { cmp, normalizeProjectInfo } from "./utils"
import { formatServerError } from "@/runtime/server/errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import type { ServerScope } from "@/runtime/server/scope"
import { withWorktreeInventory, worktreeInventoryKey } from "@/workspaces/inventory"

type GlobalStore = {
  path: Path
  project: Project[]
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
  // The last project-list failure, if any: bootstrap swallows per-query failures
  // (allSettled), so without this the home would silently show zero projects.
  projectError?: string
  projectsReady?: boolean
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false

    const finish = () => {
      if (done) return
      done = true
      resolve()
    }

    const timer = setTimeout(finish, 50)

    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

function runAll<T>(list: Array<() => Promise<T>>) {
  return Promise.allSettled(list.map((item) => item()))
}

export const loadGlobalConfigQuery = (scope: ServerScope) =>
  queryOptions({
    queryKey: [scope, "config"],
    // TODO: Restore config loading when the V2 client exposes a config API.
    queryFn: async (): Promise<Config> => ({}),
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
}

type LocationApi = { readonly get: (input?: LocationGetInput) => Promise<LocationGetOutput> }

// Metadata only. Worktree inventories load per project when a view shows it (see workspaces/inventory).
export const loadProjectsQuery = (scope: ServerScope, projects: ProjectApi) =>
  queryOptions({
    queryKey: [scope, "project"],
    // The queryFn already retries transient failures (3 attempts); a TanStack
    // retry on top would multiply it to 9 requests and ~8s of empty list.
    retry: false,
    queryFn: () =>
      retry(() =>
        projects.list().then((items) =>
          items
            .filter((project) => !!project?.id)
            .map(normalizeProjectInfo)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .sort((a, b) => cmp(a.id, b.id)),
        ),
      ),
  })

export async function bootstrapGlobal(input: {
  serverAPI: {
    readonly location: LocationApi
    readonly project: ProjectApi
  }
  scope: ServerScope
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope)).then(() => undefined),
    () =>
      input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.serverAPI.location)).then(() => undefined),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverAPI.project))
        .then((data) => {
          input.setGlobalStore("projectError", undefined)
          input.setGlobalStore("project", (previous) =>
            // A not-yet-ready server (or a wrong database file) answers with an empty
            // list: keep the projects already on screen instead of flashing an empty
            // project list. Projects are never deleted through the UI, so an empty
            // fetch never legitimately clears a non-empty store.
            data.length === 0 && previous.length > 0
              ? previous
              : data.map((project) =>
                  withWorktreeInventory(
                    project,
                    input.queryClient.getQueryData(worktreeInventoryKey(input.scope, project.id)),
                  ),
                ),
          )
        })
        .catch((error) => {
          // runAll swallows this failure (allSettled): record it so the home can
          // say the list failed instead of showing zero projects.
          input.setGlobalStore("projectError", error instanceof Error ? error.message : String(error))
        })
        .finally(() => input.setGlobalStore("projectsReady", true)),
  ]

  await runAll(slow)
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

export const loadPathQuery = (scope: ServerScope, directory: string | null, api: LocationApi) =>
  queryOptions<Path>({
    queryKey: [scope, directory, "path"],
    queryFn: () =>
      api.get(directory ? { location: { directory } } : undefined).then((location) => ({
        state: "",
        config: "",
        worktree: location.project.directory,
        directory: location.directory,
        home: "",
      })),
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  api: {
    readonly project: ProjectApi
    readonly location: LocationApi
  }
  store: Store<State>
  setStore: SetStoreFunction<State>
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
  }
  queryClient: QueryClient
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)

  if (seededProject) input.setStore("project", seededProject)

  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }

  if (loading) input.setStore("status", "partial")

  const slow = [
    seededProject
      ? undefined
      : () =>
          retry(() => input.api.location.get({ location: { directory: input.directory } })).then((location) =>
            input.setStore("project", location.project.id),
          ),
  ].filter((task): task is () => Promise<void> => !!task)

  await waitForPaint()
  const slowErrs = errors(await runAll(slow))

  if (slowErrs.length > 0) {
    console.error("Failed to finish bootstrap instance", slowErrs[0])
    const project = getFilename(input.directory)
    showToast({
      variant: "error",
      title: input.translate("toast.project.reloadFailed.title", { project }),
      description: formatServerError(slowErrs[0], input.translate),
    })
  }

  if (loading && slowErrs.length === 0) input.setStore("status", "complete")
}
