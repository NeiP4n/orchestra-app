import { Menu } from "@orchestra/ui/menu"
import { Icon } from "@orchestra/ui/icon"
import { showToast } from "@orchestra/ui/toast"
import { createSignal, For, Show, type ComponentProps, type JSX } from "solid-js"
import { createLatest, useExtension, type MountedSession } from "../sdk"
import { hasGithubDirectory } from "./github"

/** Whether the project root holds a `.github` directory, the marker that lets a session switch branches. */
export function createGithubProject(session: () => MountedSession, worktree: () => string) {
  const found = createLatest(
    () => (session().server.connected ? { worktree: worktree() } : undefined),
    async (value, signal) => {
      const listing = await session().server.client.file.list({ location: { directory: value.worktree } }, { signal })

      return hasGithubDirectory(listing.data)
    },
  )

  return () => found.latest ?? false
}

export function SessionBranchMenu(props: {
  session: MountedSession
  /** The directory the session runs in: the branch that changes. */
  directory: string
  current: string
  placement?: ComponentProps<typeof Menu>["placement"]
  class?: string
  children: JSX.Element
}) {
  const ctx = useExtension()
  const [branches, setBranches] = createSignal<readonly string[]>([])
  const [switching, setSwitching] = createSignal<string>()

  // Switching under a running agent would change files it is editing.
  const blocked = () => props.session.server.data.session.status(props.session.id) === "running"

  const onOpenChange = (open: boolean) => {
    if (!open) return
    void props.session.server.client.vcs.branch
      .list({ location: { directory: props.directory }, limit: 50 })
      .then((response) => setBranches(response.data))
      .catch(() => undefined)
  }

  const switchTo = async (branch: string) => {
    if (switching() || blocked() || branch === props.current) return
    setSwitching(branch)

    try {
      await props.session.server.client.vcs.branch.checkout({ location: { directory: props.directory }, branch })
    } catch (error) {
      showToast({
        variant: "error",
        title: ctx.t("branch.failed"),
        description: error instanceof Error ? error.message : ctx.t("common.requestFailed"),
      })
    } finally {
      setSwitching(undefined)
    }
  }

  return (
    <Menu
      placement={props.placement ?? "bottom-end"}
      gutter={4}
      overflowPadding={24}
      modal={false}
      onOpenChange={onOpenChange}
    >
      <Menu.Trigger class={props.class} disabled={blocked()}>
        {props.children}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content class="max-h-[66.667dvh] w-[240px] overflow-y-auto">
          <Menu.Group>
            <Menu.GroupLabel>{ctx.t("branch.menu")}</Menu.GroupLabel>
            <Show
              when={branches().length > 0}
              fallback={<div class="px-3 py-2 text-12-regular text-text-weak">{ctx.t("branch.loading")}</div>}
            >
              <For each={branches()}>
                {(branch) => (
                  <Menu.Item disabled={!!switching() || blocked()} onSelect={() => void switchTo(branch)}>
                    <Icon name={branch === props.current ? "check" : "branch"} />
                    <span class="min-w-0 flex-1 truncate">{branch}</span>
                  </Menu.Item>
                )}
              </For>
            </Show>
          </Menu.Group>
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
