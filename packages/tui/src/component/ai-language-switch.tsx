import { createSignal, For } from "solid-js"
import { useConfig } from "../config"
import { useTheme } from "../context/theme"
import { hoverBackground } from "../ui/hover"
import { useToast } from "../ui/toast"
import type { AiLanguage } from "../util/ai-language"
import { useT } from "../util/i18n"
import { neuralPalette } from "./neural"

// Three small buttons beside the prompt: the AI thinks and answers in Russian, in English, or in
// whatever language the conversation takes. What the user types is never restricted.
export function AiLanguageSwitch(props: { compact?: boolean }) {
  const config = useConfig()
  const theme = useTheme()
  const toast = useToast()
  const t = useT()
  const [hovered, setHovered] = createSignal<AiLanguage>()
  const current = () => config.data.ai_language ?? "auto"
  const choices: { value: AiLanguage; label: string; hint: string }[] = [
    { value: "ru", label: "RU", hint: "AI answers in Russian" },
    { value: "en", label: "EN", hint: "AI answers in English" },
    { value: "auto", label: "Auto", hint: "AI answers in any language" },
  ]
  const pick = (value: AiLanguage) =>
    void config
      .update((draft) => {
        if (value === "auto") delete draft.ai_language
        else draft.ai_language = value
      })
      .then(() => toast.show({ variant: "info", message: t(choices.find((item) => item.value === value)!.hint), duration: 2500 }))
      .catch(toast.error)
  // A narrow prompt keeps one button that steps through the three modes.
  const visible = () => (props.compact ? choices.filter((item) => item.value === current()) : choices)
  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={visible()}>
        {(item) => {
          const active = () => current() === item.value
          return (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={
                active()
                  ? theme.background.action.primary.focused
                  : hovered() === item.value
                    ? hoverBackground(theme)
                    : undefined
              }
              onMouseOver={() => setHovered(item.value)}
              onMouseOut={() => setHovered(undefined)}
              onMouseUp={(event) => {
                event.stopPropagation()
                if (!props.compact) return pick(item.value)
                const index = choices.findIndex((choice) => choice.value === current())
                pick(choices[(index + 1) % choices.length]!.value)
              }}
            >
              <text
                selectable={false}
                fg={
                  active()
                    ? theme.text.action.primary.focused
                    : hovered() === item.value
                      ? neuralPalette(theme).signal
                      : theme.text.muted
                }
              >
                {t(item.label)}
              </text>
            </box>
          )
        }}
      </For>
    </box>
  )
}
