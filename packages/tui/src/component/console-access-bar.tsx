import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { ConsoleAccess } from "@orchestra/core/console-access"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { HoverAction } from "./hover-action"
const modes: ConsoleAccess.Mode[] = ["off", "read", "confirm", "full"]
const labels = { off: "OFF", read: "чтение", confirm: "с подтверждением", full: "полный ввод" }
export function ConsoleAccessBar(props: {
  sessionID: string
  directory: string
  projectID?: string
  kind: "persistent" | "plain"
  ptyID?: string
}) {
  const dialog = useDialog(),
    theme = useTheme(),
    toast = useToast(),
    [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((n) => n + 1), 1000)
  onCleanup(() => clearInterval(timer))
  const scope = (): ConsoleAccess.Scope | undefined =>
    props.ptyID && props.projectID
      ? {
          sessionID: props.sessionID,
          directory: props.directory,
          projectID: props.projectID,
          kind: props.kind,
          ptyID: props.ptyID,
        }
      : undefined
  createEffect(() => {
    const s = scope()
    if (s)
      try {
        ConsoleAccess.select(s)
        onCleanup(() => {
          try {
            ConsoleAccess.unselect(s)
          } catch (error) {
            toast.error(error)
          }
        })
      } catch (error) {
        toast.error(error)
      }
  })
  const grant = () => {
    tick()
    const s = scope()
    return s ? ConsoleAccess.current(s) : undefined
  }
  const refresh = () => setTick((n) => n + 1)
  function change(mode: ConsoleAccess.Mode) {
    const s = scope()
    if (!s) return
    try {
      ConsoleAccess.set(s, mode)
      refresh()
      dialog.clear()
    } catch (error) {
      toast.error(error)
    }
  }
  function open() {
    const s = scope()
    if (!s) return
    const current = ConsoleAccess.current(s)
    const rows = [
      ...modes.map((mode) => ({
        title: labels[mode],
        value: mode,
        footer:
          mode === current.mode
            ? "сейчас"
            : modes.indexOf(mode) > modes.indexOf(current.mode)
              ? "расширение"
              : "сузить",
      })),
      ...(current.pending ? [{ title: "Проверить ожидающую команду", value: "approve", footer: "точный текст" }] : []),
      { title: "Журнал попыток", value: "journal", footer: "без текста" },
      { title: "Ограничения доступа", value: "limits", footer: "прочитать" },
    ]
    dialog.replace(() => (
      <DialogSelect
        compact
        renderFilter={false}
        title={`ИИ в консоли · ${labels[current.mode]}`}
        current={current.mode}
        options={rows}
        bindings={[
          {
            bind: "left",
            title: "Сузить",
            group: "Console",
            run: () => change(modes[Math.max(0, modes.indexOf(current.mode) - 1)]!),
          },
          {
            bind: "right",
            title: "Расширить сразу",
            group: "Console",
            run: () => change(modes[Math.min(3, modes.indexOf(current.mode) + 1)]!),
          },
        ]}
        onSelect={(option) => {
          if (option.value === "limits")
            return dialog.replace(() => (
              <DialogSelect
                compact
                renderFilter={false}
                title="Ограничения доступа"
                options={[
                  { title: "Только текущая консоль этого чата и проекта", value: "scope" },
                  { title: "Доступ истекает через час; можно отозвать сразу", value: "expiry" },
                  { title: "Отдельные shell/bash этим режимом не ограничены", value: "shell" },
                  { title: "Vault-инъекция не подключена", value: "vault" },
                  { title: "Удалённый сервис или другое хранилище: OFF", value: "remote" },
                  { title: "Отправка ввода не доказывает успех команды", value: "result" },
                ]}
              />
            ))
          if (option.value === "journal")
            return dialog.replace(() => (
              <DialogSelect
                compact
                renderFilter={false}
                title="Журнал попыток Console (не результат команды)"
                options={ConsoleAccess.recent(s).map((event, index) => ({
                  title: `${new Date(event.at).toLocaleTimeString()} · ${event.action === "read" ? "чтение" : "ввод"} · ${event.bytes} байт`,
                  value: index,
                }))}
                footer={
                  <text fg={theme.text.muted}>
                    Только попытки, без команд и вывода. Отправка ввода не доказывает успех команды.
                  </text>
                }
              />
            ))
          if (option.value !== "approve") return change(option.value as ConsoleAccess.Mode)
          const expected = current.pending
          if (!expected) return
          dialog.replace(() => (
            <DialogSelect
              compact
              renderFilter={false}
              title="Проверить точную команду"
              options={[
                { title: "Отмена", value: "cancel" },
                { title: "Выполнить один раз", value: "approve" },
              ]}
              onSelect={(choice) => {
                if (choice.value === "approve")
                  try {
                    ConsoleAccess.approve(s, expected, current.revision)
                    refresh()
                  } catch (error) {
                    toast.error(error)
                  }
                dialog.clear()
              }}
              footer={
                <text fg={theme.text.base} wrapMode="word">
                  {JSON.stringify(expected)}. Только текущая консоль. Незавершённый ввод меняет смысл команды.
                </text>
              }
            />
          ))
        }}
        footer={
          <text fg={theme.text.muted} wrapMode="word">
            ←/→ сразу · эта консоль ·{" "}
            {current.mode === "off"
              ? "OFF"
              : `до ${new Date(current.expiresAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`}
          </text>
        }
      />
    ))
  }
  return (
    <box flexDirection="row" flexShrink={0} gap={1} minWidth={0}>
      <HoverAction onClick={open}>
        <text
          fg={grant()?.mode && grant()?.mode !== "off" ? theme.text.feedback.warning.base : theme.text.muted}
          wrapMode="none"
        >
          {props.ptyID
            ? `ИИ: ${labels[grant()?.mode ?? "off"]}${grant()?.mode !== "off" ? " · расширено" : ""}${grant()?.pending ? " · команда ждёт" : ""} · доступ…`
            : "ИИ: OFF · терминал подключается"}
        </text>
      </HoverAction>
      <Show when={grant()?.mode !== "off" && props.ptyID}>
        <HoverAction onClick={() => change("off")}>
          <text fg={theme.text.feedback.error.base}>[отозвать]</text>
        </HoverAction>
      </Show>
    </box>
  )
}
