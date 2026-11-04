import { For, Show, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@orchestra/ui/icon"
import { IconButton } from "@orchestra/ui/icon-button"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { showToast } from "@/shell/notifications/toast"
import { followUpActions, followUpVisible, type FollowUpActionID, type FollowUpAnswer } from "./follow-up"

const LABEL_KEYS = {
  continue: "session.followUp.action.continue",
  summarize: "session.followUp.action.summarize",
  details: "session.followUp.action.details",
  plan: "session.followUp.action.plan",
  risks: "session.followUp.action.risks",
  explainCode: "session.followUp.action.explainCode",
} as const

const PROMPT_KEYS = {
  continue: "session.followUp.prompt.continue",
  summarize: "session.followUp.prompt.summarize",
  details: "session.followUp.prompt.details",
  plan: "session.followUp.prompt.plan",
  risks: "session.followUp.prompt.risks",
  explainCode: "session.followUp.prompt.explainCode",
} as const

/**
 * One-click follow-ups above the composer for the latest completed answer.
 * Sending reuses the session's steer prompt path, the same one interactive
 * widgets in answers use, so a click behaves exactly like typing the
 * follow-up and pressing send.
 */
export function SessionFollowUpBar(props: {
  answer: FollowUpAnswer | undefined
  working: boolean
  blocked: boolean
  child: boolean
  onSend: (text: string) => Promise<void> | void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore<{
    dismissedMessageID: string | undefined
    sending: FollowUpActionID | undefined
    copied: boolean
  }>({ dismissedMessageID: undefined, sending: undefined, copied: false })

  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (copiedTimer !== undefined) clearTimeout(copiedTimer)
  })

  const visible = () =>
    followUpVisible({
      answer: props.answer,
      working: props.working,
      blocked: props.blocked,
      child: props.child,
      dismissedMessageID: store.dismissedMessageID,
    })

  const send = (action: FollowUpActionID) => {
    if (store.sending) return
    setStore("sending", action)
    Promise.resolve(props.onSend(language.t(PROMPT_KEYS[action]))).then(
      () => setStore("sending", undefined),
      () => {
        setStore("sending", undefined)
        showToast({ title: language.t("common.requestFailed") })
      },
    )
  }

  const copy = () => {
    const text = props.answer?.text

    if (!text) return
    const write = platform.writeClipboardText ? platform.writeClipboardText(text) : navigator.clipboard.writeText(text)
    void Promise.resolve(write).then(
      () => {
        setStore("copied", true)
        if (copiedTimer !== undefined) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => setStore("copied", false), 2000)
      },
      () => showToast({ title: language.t("common.requestFailed") }),
    )
  }

  return (
    <Show when={visible() ? props.answer : undefined}>
      {(answer) => (
        <div
          data-component="session-follow-up-bar"
          role="group"
          aria-label={language.t("session.followUp.title")}
          class="flex flex-wrap items-center gap-1.5 pb-2"
        >
          <For each={followUpActions(answer().text)}>
            {(action) => (
              <button
                type="button"
                data-slot="follow-up-action"
                data-action={action}
                disabled={store.sending !== undefined}
                class="rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-[12px] font-[500] leading-[var(--line-height-compact)] text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover disabled:opacity-50"
                onClick={() => send(action)}
              >
                {language.t(LABEL_KEYS[action])}
              </button>
            )}
          </For>
          <button
            type="button"
            data-slot="follow-up-copy"
            class="inline-flex items-center gap-1 rounded-full border border-border-weak-base bg-background-base px-2.5 py-1 text-[12px] font-[500] leading-[var(--line-height-compact)] text-text-base transition-colors hover:bg-v2-overlay-simple-overlay-hover"
            onClick={copy}
          >
            <Icon name={store.copied ? "check" : "copy"} size="small" />
            {language.t(store.copied ? "session.followUp.copied" : "session.followUp.copy")}
          </button>
          <IconButton
            icon={<Icon name="close" size="small" />}
            variant="ghost-muted"
            size="small"
            aria-label={language.t("session.followUp.dismiss")}
            onClick={() => setStore("dismissedMessageID", answer().messageID)}
          />
        </div>
      )}
    </Show>
  )
}
