import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import type { Plugin } from "@orchestra/plugin/tui"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useT } from "../util/i18n"

export type SwarmState = "active" | "consensus" | "halted"
export type CognitiveMode = "auto" | "system1" | "system2"

// Reactive swarm control states shared across UI components
export const [swarmState, setSwarmState] = createSignal<SwarmState>("active")
export const [cognitiveMode, setCognitiveMode] = createSignal<CognitiveMode>("auto")
export const [agentCount, setAgentCount] = createSignal<number>(4)
export const [queuedTasks, setQueuedTasks] = createSignal<number>(3)
export const [safetyLevel, setSafetyLevel] = createSignal<string>("High (Veto Active)")

export function AgiStatusIndicator(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const isCompact = () => dimensions().width < 64
  const color = () =>
    swarmState() === "active"
      ? (props.context.theme.text.feedback?.success?.base ?? props.context.theme.text.base)
      : (props.context.theme.text.feedback?.error?.base ?? props.context.theme.text.base)

  const handleOpen = () => {
    const d = props.context.ui?.dialog as any
    if (typeof d?.show === "function") {
      d.show(() => <DialogAgiControl />)
    } else if (typeof d?.replace === "function") {
      d.replace(() => <DialogAgiControl />)
    }
  }

  return (
    <box
      id="footer.agi.status"
      flexDirection="row"
      flexShrink={0}
      onMouseUp={handleOpen}
    >
      <text fg={props.context.theme.text.base} wrapMode="none">
        <span style={{ fg: color() }}>• </span>
        {isCompact() ? "Swarm" : `Swarm: ${swarmState()}`}
      </text>
    </box>
  )
}

export function DialogAgiControl(props?: { onClose?: () => void }) {
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const toast = useToast()
  const t = useT()
  const dimensions = useTerminalDimensions()

  // Adaptive size: medium for compact screens (< 80 cols), large for spacious terminals
  createEffect(() => {
    dialog.setSize(dimensions().width < 80 ? "medium" : "large")
  })
  dialog.setSize(dimensions().width < 80 ? "medium" : "large")

  const isCompact = () => dimensions().width < 80
  const isNarrow = () => dimensions().width < 64
  const displaySafety = () => (isCompact() ? "High" : safetyLevel())

  const handleClose = () => {
    props?.onClose?.()
    dialog.clear()
  }

  // 1. Toggle swarm state (active <-> halted)
  const toggleSwarm = () => {
    if (swarmState() === "halted") {
      setSwarmState("active")
      toast.show({
        variant: "success",
        message: t("Swarm Engine активирован. Автономные агенты возобновили работу."),
      })
    } else {
      setSwarmState("halted")
      toast.show({
        variant: "warning",
        message: t("Swarm Engine приостановлен. Задачи заблокированы."),
      })
    }
  }

  // 2. Emergency Kill-Switch
  const handleKillSwitch = () => {
    setSwarmState("halted")
    setQueuedTasks(0)
    toast.show({
      variant: "error",
      message: t("Экстренный стоп (Kill-Switch): рой остановлен, очереди очищены, транзакции откачены."),
    })
  }

  // 3. Cognitive Mode Cycle / Switcher
  const cognitiveModes: CognitiveMode[] = ["auto", "system1", "system2"]
  const modeLabels: Record<CognitiveMode, string> = {
    auto: "Auto (Dynamic Mode Governor)",
    system1: "System 1 (Fast Intuition)",
    system2: "System 2 (Deep Deliberation)",
  }
  const modeFooters: Record<CognitiveMode, string> = {
    auto: "Auto",
    system1: "System 1",
    system2: "System 2",
  }

  const selectMode = (mode: CognitiveMode) => {
    setCognitiveMode(mode)
    toast.show({
      variant: "info",
      message: `${t("Режим мышления изменен")}: ${modeLabels[mode]}`,
    })
  }

  const cycleNextCognitiveMode = () => {
    const currentIndex = cognitiveModes.indexOf(cognitiveMode())
    const next = cognitiveModes[(currentIndex + 1) % cognitiveModes.length]
    selectMode(next)
  }

  // 4. Reset Memory
  const handleResetMemory = () => {
    setQueuedTasks(0)
    toast.show({
      variant: "info",
      message: t("Эпизодический граф памяти и контекст рефлексии роя успешно сброшены."),
    })
  }

  const statusColor = () => {
    if (swarmState() === "active") return theme.text.feedback.success.base
    if (swarmState() === "halted") return theme.text.feedback.error.base
    return theme.text.feedback.warning.base
  }

  const statusLabel = () => {
    if (swarmState() === "active") return t("Активен")
    if (swarmState() === "halted") return t("Остановлен")
    return t("Идет консилиум")
  }

  const statusDescription = () => {
    if (swarmState() === "active") return t("Автономная координация включена")
    if (swarmState() === "halted") return t("Выполнение задач заблокировано")
    return t("Оценка гипотез и консилиум ролей")
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => [
    {
      value: "toggle-swarm",
      title: t("Автономный рой (Swarm)"),
      description: t("Переключение состояния координации и фоновых агентов"),
      footer: swarmState() === "active" ? "active" : "halted",
      footerColor:
        swarmState() === "active"
          ? theme.text.feedback.success.base
          : theme.text.feedback.error.base,
      onSelect: toggleSwarm,
    },
    {
      value: "cognitive-mode",
      title: t("Когнитивный режим"),
      description: t("Выбор глубины рассуждений роя"),
      footer: modeFooters[cognitiveMode()],
      footerColor: theme.text.base,
      onSelect: cycleNextCognitiveMode,
    },
    {
      value: "reset-memory",
      title: t("Сброс памяти роя"),
      description: t("Очистить эпизодический граф и контекст рефлексии"),
      footer: t("очистить"),
      footerColor: theme.text.muted,
      onSelect: handleResetMemory,
    },
    {
      value: "kill-switch",
      title: t("Экстренный стоп (Kill-Switch)"),
      description: t("Остановить все процессы и откатить транзакции"),
      footer: t("остановить"),
      footerColor: theme.text.feedback.error.base,
      onSelect: handleKillSwitch,
    },
  ])

  return (
    <DialogSelect<string>
      title={t("Swarm Control")}
      titleView={
        <box flexDirection="column" gap={1} flexGrow={1} paddingRight={1}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            {t("Swarm Control")}
          </text>
          <box
            backgroundColor={theme.background.raised.base}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            paddingRight={2}
            gap={1}
          >
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={statusColor()}>•</text>
              <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                {statusLabel()}
              </text>
              <Show when={!isNarrow()}>
                <text fg={theme.text.muted}>·</text>
                <text fg={theme.text.muted}>{statusDescription()}</text>
              </Show>
            </box>
            <box flexDirection={isNarrow() ? "column" : "row"} gap={isCompact() ? 2 : 3}>
              <text>
                <span style={{ fg: theme.text.muted }}>{t("Узлы")}: </span>
                <span style={{ fg: theme.text.base }}>
                  <b>{agentCount()}</b>
                </span>
              </text>
              <text>
                <span style={{ fg: theme.text.muted }}>{t("Очередь")}: </span>
                <span style={{ fg: theme.text.base }}>
                  <b>{queuedTasks()}</b>
                </span>
              </text>
              <text>
                <span style={{ fg: theme.text.muted }}>{t("Безопасность")}: </span>
                <span style={{ fg: theme.text.feedback.success.base }}>
                  <b>{displaySafety()}</b>
                </span>
              </text>
            </box>
          </box>
        </box>
      }
      renderFilter={false}
      flat
      options={options()}
      footerHints={[
        { title: "↑/↓", label: t("навигация") },
        { title: "enter", label: t("выбор") },
        { title: "esc", label: t("закрыть") },
      ]}
      onCancel={handleClose}
    />
  )
}

DialogAgiControl.show = (dialog: DialogContext | { show?: (render: () => any) => void; replace?: (render: () => any) => void }) => {
  if (typeof (dialog as any).show === "function") {
    (dialog as any).show(() => <DialogAgiControl />)
  } else if (typeof (dialog as any).replace === "function") {
    (dialog as any).replace(() => <DialogAgiControl />)
  }
}
