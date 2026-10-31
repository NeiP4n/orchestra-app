import { createMemo, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useDialog } from "@orchestra/ui/context/dialog"
import { Collapsible } from "@orchestra/ui/collapsible"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@orchestra/ui/dialog"
import { Button } from "@orchestra/ui/button"
import { TextInput } from "@orchestra/ui/text-input"
import { Textarea } from "@orchestra/ui/textarea"
import { Spinner } from "@orchestra/ui/spinner"
import { Icon } from "@orchestra/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { useTabs } from "@/shell/tabs/tabs"
import { showToast } from "@/shell/notifications/toast"

// The built-in team whose project covers every layer of the system.
export const AI_TEAM_TEMPLATE = "system"

export function DialogAiTeam(props: { server: ServerConnection.Any }) {
  const dialog = useDialog()
  const language = useLanguage()
  const global = useGlobal()
  const tabs = useTabs()
  const [form, setForm] = createStore({ name: "", goal: "", directory: "", busy: false, more: false })
  const canCreate = createMemo(() => form.goal.trim().length > 0 && !form.busy)

  async function create() {
    const goal = form.goal.trim()
    const name = form.name.trim()
    const directory = form.directory.trim()

    if (!goal || form.busy) return
    setForm("busy", true)
    const ctx = global.ensureServerCtx(props.server)

    // An empty optional field stays out of the request body: the server names the Society and picks its folder.
    const input = {
      goal,
      team: AI_TEAM_TEMPLATE,
      name: name || undefined,
      directory: directory || undefined,
    }

    try {
      const society = await ctx.sdk.api.orchestra.society.create(input)

      // The Society exists as soon as the create answers. Close first, so a failed follow-up read cannot leave the
      // operator in front of a dialog whose button would create a second one.
      dialog.close()
      void startTransition(() => {
        const tab = tabs.addSessionTab({ server: ServerConnection.key(props.server), sessionId: society.sessionID })
        tabs.select(tab)
      })
      showToast({
        title: language.t("home.aiTeam.created"),
        description: society.name,
      })

      const session = await ctx.sdk.api.session.get({ sessionID: society.sessionID }).catch((cause: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: cause instanceof Error ? cause.message : String(cause),
        })
      })

      if (!session) return
      ctx.data.session.remember(session)
      void ctx.data.session.message.sync(session.id).catch(() => undefined)
    } catch (cause) {
      setForm("busy", false)
      showToast({
        title: language.t("common.requestFailed"),
        description: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  // Enter creates the team from the goal; Shift+Enter keeps the newline the textarea would insert. An input method
  // composition owns Enter until it commits, so the key belongs to the IME then.
  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    event.preventDefault()
    void create()
  }

  return (
    <Dialog>
      <DialogHeader>
        <DialogTitleGroup
          title={
            <span class="flex items-center gap-2">
              <Icon name="brain" size="small" class="text-v2-icon-icon-muted" />
              {language.t("home.aiTeam.title")}
            </span>
          }
          description={language.t("home.aiTeam.description")}
        />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-4">
        <label class="flex flex-col gap-1.5">
          <span class="text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
            {language.t("home.aiTeam.goal")}
          </span>
          <Textarea
            rows={4}
            autofocus
            disabled={form.busy}
            value={form.goal}
            placeholder={language.t("home.aiTeam.goal.placeholder")}
            aria-label={language.t("home.aiTeam.goal")}
            onInput={(event) => setForm("goal", event.currentTarget.value)}
            onKeyDown={submitOnEnter}
          />
        </label>
        <Collapsible variant="ghost" open={form.more} onOpenChange={(open) => setForm("more", open)}>
          <Collapsible.Trigger disabled={form.busy}>
            <span>{language.t("common.moreOptions")}</span>
            <Collapsible.Arrow />
          </Collapsible.Trigger>
          <Collapsible.Content>
            <div class="flex flex-col gap-4 pt-2">
              <label class="flex flex-col gap-1.5">
                <span class="text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {language.t("home.aiTeam.name")}
                </span>
                <TextInput
                  value={form.name}
                  disabled={form.busy}
                  placeholder={language.t("home.aiTeam.name.placeholder")}
                  aria-label={language.t("home.aiTeam.name")}
                  onInput={(event) => setForm("name", event.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-1.5">
                <span class="text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {language.t("home.aiTeam.parentFolder")}
                </span>
                <TextInput
                  value={form.directory}
                  disabled={form.busy}
                  placeholder={language.t("home.aiTeam.parentFolder.placeholder")}
                  aria-label={language.t("home.aiTeam.parentFolder")}
                  spellcheck={false}
                  onInput={(event) => setForm("directory", event.currentTarget.value)}
                />
              </label>
              <p class="text-[13px] leading-[var(--line-height-base)] text-v2-text-text-muted">
                {language.t("home.aiTeam.coverage")}
              </p>
            </div>
          </Collapsible.Content>
        </Collapsible>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" disabled={form.busy} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button
          icon={form.busy ? undefined : "brain"}
          disabled={!canCreate()}
          aria-busy={form.busy}
          onClick={() => void create()}
        >
          {form.busy ? <Spinner class="size-3.5" /> : undefined}
          {language.t(form.busy ? "home.aiTeam.creating" : "home.aiTeam.create")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
