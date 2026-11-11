import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { ScheduleView } from "@orchestra/core/schedule-view"
import { ScheduleRequests } from "@orchestra/core/schedule-requests"
import { BrowserSchedule } from "@orchestra/core/browser/schedule"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { HoverAction } from "./hover-action"
import { ScheduleLimitDialog } from "./schedule-limit-dialog"
import { scheduleDetails, scheduleState } from "../util/schedule-list"

export function DialogSchedules(props: { sessionID: string }) {
  const theme = useTheme(),
    dialog = useDialog()
  const [tick, setTick] = createSignal(0),
    [selected, setSelected] = createSignal<string>(),
    [armed, setArmed] = createSignal<string>(),
    [notice, setNotice] = createSignal("")
  const [checked, setChecked] = createSignal<Record<string, { digest: string; browser: boolean }>>({})
  const [batch, setBatch] = createSignal<ScheduleRequests.Command[]>([])
  const isChecked = (item: ScheduleView.Item) => !!item.review && checked()[item.id]?.digest === item.review.digest
  const toggleChecked = () => {
    const item = current()
    if (!item || item.enabled || !item.review || batch().length) return
    setChecked((previous) => {
      const next = { ...previous }
      if (isChecked(item)) delete next[item.id]
      else next[item.id] = { digest: item.review!.digest, browser: false }
      return next
    })
  }
  const toggleBrowser = () => {
    const item = current()
    if (!item || !isChecked(item) || !item.review?.browser || batch().length) return
    setChecked((previous) => ({
      ...previous,
      [item.id]: { digest: item.review!.digest, browser: !previous[item.id]?.browser },
    }))
  }
  const enableChecked = () => {
    if (batch().length || pending()) return
    const chosen = Object.entries(checked())
    if (!chosen.length) {
      setNotice("Отметьте проверенные триггеры.")
      return
    }
    const ready = chosen.map(([id, check]) =>
      items().find(
        (item) =>
          item.id === id &&
          !item.enabled &&
          item.review?.digest === check.digest &&
          (!item.review.browser || check.browser),
      ),
    )
    if (ready.some((item) => !item)) {
      setNotice("Проверьте изменившиеся триггеры и подтвердите страницу/вход браузера.")
      return
    }
    const requests: ScheduleRequests.Command[] = []
    try {
      for (const item of ready)
        if (item?.review)
          requests.push(ScheduleRequests.requestReviewedResume(item.id, props.sessionID, item.review.digest))
      setNotice("Запросы сохранены. Ждём подтверждения сервиса.")
      setChecked({})
    } catch {
      setNotice("Часть запросов могла сохраниться. Изменившиеся триггеры проверьте заново.")
    }
    setBatch(requests)
  }
  const [pending, setPending] = createSignal<ScheduleRequests.Command>()
  const items = createMemo(() => {
    tick()
    return ScheduleView.list(props.sessionID)
  })
  const current = () => items().find((item) => item.id === selected()) ?? items()[0]
  const status = () => {
    tick()
    const item = current()
    return item ? BrowserSchedule.get(item.id) : undefined
  }
  onMount(() => {
    dialog.setSize("large")
    dialog.setCentered(true)
  })
  const timer = setInterval(() => {
    setTick((n) => n + 1)
    const request = pending(),
      result = request ? ScheduleRequests.result(request) : undefined
    if (batch().length) {
      const results = batch().map((request) => ScheduleRequests.result(request))
      if (results.every((result) => result)) {
        const succeeded = results.filter((result) => result?.ok).length
        setNotice(
          `Включено: ${succeeded} из ${results.length}. ${results
            .filter((result) => !result?.ok)
            .map((result) => result?.message)
            .join(" ")}`,
        )
        setBatch([])
      }
    }
    if (result) {
      setNotice(result.message)
      setPending()
    }
  }, 2000)
  onCleanup(() => clearInterval(timer))
  const command = (action: ScheduleRequests.Command["action"]) => {
    const item = current()
    if (!item || pending() || batch().length) return
    try {
      setPending(ScheduleRequests.request(item.id, props.sessionID, action))
      setNotice("Запрос сохранён. Ждём сервис.")
    } catch {
      setNotice("Запрос не сохранён. Проверьте триггер.")
    }
  }
  const remove = () => {
    const item = current()
    if (!item) return
    if (armed() !== item.id) {
      setArmed(item.id)
      setNotice("Удалить этот триггер? Нажмите «Удалить» ещё раз.")
      return
    }
    try {
      ScheduleView.requestRemoval(item.id, props.sessionID)
      setNotice("Удаление запрошено. Ждём сервис.")
      setArmed()
    } catch {
      setNotice("Не удалось запросить удаление.")
    }
  }
  const limit = (day = false) => {
    const item = current()
    if (item) dialog.replace(() => <ScheduleLimitDialog item={item} sessionID={props.sessionID} day={day} />)
  }
  return (
    <DialogSelect
      title="Триггеры"
      skipFilter
      renderFilter={false}
      compact
      current={selected()}
      options={items().map((item) => ({
        value: item.id,
        title: item.name || "Без названия",
        footer: scheduleState(item, BrowserSchedule.get(item.id)),
      }))}
      onMove={(option) => {
        if (selected() !== option.value) {
          setSelected(option.value)
          setArmed()
          if (!pending()) setNotice("")
        }
      }}
      emptyView={<text fg={theme.text.muted}>В этом чате пока нет триггеров.</text>}
      bindings={[
        {
          bind: "p",
          title: "Пауза / включить",
          group: "Триггеры",
          run: () => command(current()?.enabled ? "pause" : "resume"),
        },
        { bind: "c", title: "Проверен", group: "Триггеры", run: toggleChecked },
        { bind: "b", title: "Вход и страница проверены", group: "Триггеры", run: toggleBrowser },
        { bind: "a", title: "Включить проверенные триггеры", group: "Триггеры", run: enableChecked },
        { bind: "d", title: "Удалить (дважды)", group: "Триггеры", run: remove },
        { bind: "e", title: "Сохранить шаблон", group: "Триггеры", run: () => command("export") },
        { bind: "h", title: "Лимит в час", group: "Триггеры", run: () => limit() },
        { bind: "j", title: "Лимит в сутки", group: "Триггеры", run: () => limit(true) },
      ]}
      footer={
        <box flexDirection="column" gap={1} minWidth={0}>
          <Show when={current()}>
            {(item) => (
              <>
                <text fg={theme.text.muted} wrapMode="word">
                  {item().kind === "browser"
                    ? "Реагирует на новые строки страницы."
                    : item().kind === "internal"
                      ? "Реагирует на результат работы агента."
                      : "Запускает сохранённую задачу по времени."}{" "}
                  {scheduleState(item(), status())}.
                </text>
                <text fg={theme.text.muted}>
                  Лимиты: {(item().fired ?? []).filter((at) => at > Date.now() - 3600_000).length}/
                  {item().maxPerHour === null ? "∞" : (item().maxPerHour ?? 6)} в час ·{" "}
                  {(item().fired ?? []).filter((at) => at > Date.now() - 86400_000).length}/{item().maxPerDay ?? 48} в
                  сутки
                </text>
                <text fg={theme.text.muted} wrapMode="word">
                  {scheduleDetails(item(), status()).find((line) => line.startsWith("Последний результат:"))}
                </text>
                <Show when={status()?.watcherReason || item().pausedReason}>
                  <text fg={theme.text.feedback.warning.base} wrapMode="word">
                    {status()?.watcherReason ||
                      scheduleDetails(item(), status()).find((line) => line.startsWith("Причина паузы:"))}
                  </text>
                </Show>
                <Show when={status()?.droppedPendingRows}>
                  <text fg={theme.text.feedback.warning.base}>
                    Очередь переполнена: пропущено {status()?.droppedPendingRows} строк.
                  </text>
                </Show>
                <text fg={theme.text.muted} wrapMode="word">
                  Секреты из шаблонов нужно привязать отдельно. Импорт с секретами пока не запускается.
                </text>
                <Show when={!item().enabled && item().review}>
                  <scrollbox height={6}>
                    <text fg={theme.text.muted} wrapMode="word">
                      Инструкция: {item().review?.prompt}
                    </text>
                    <text fg={theme.text.muted} wrapMode="word">
                      Источник: {item().review?.source}
                    </text>
                    <text fg={theme.text.muted} wrapMode="word">
                      Условие: {item().review?.condition || "нет"}
                    </text>
                    <Show when={item().review?.actions}>
                      <text fg={theme.text.muted} wrapMode="word">
                        Действия: {item().review?.actions}
                      </text>
                    </Show>
                  </scrollbox>
                  <HoverAction onClick={toggleChecked}>
                    <text fg={theme.text.action.primary.base} wrapMode="word">
                      [c {isChecked(item()) ? "✓" : " "}] Инструкция, расписание, лимиты и учётные данные проверены
                    </text>
                  </HoverAction>
                  <Show when={item().review?.browser}>
                    <HoverAction onClick={toggleBrowser}>
                      <text fg={theme.text.action.primary.base} wrapMode="word">
                        [b {isChecked(item()) && checked()[item().id]?.browser ? "✓" : " "}] Новый браузер привязан;
                        вход и нужная страница/чат проверены
                      </text>
                    </HoverAction>
                  </Show>
                  <text fg={theme.text.muted} wrapMode="word">
                    Включение не даёт права публикации и не меняет лимиты.
                  </text>
                </Show>
                <box flexDirection="row" gap={2} flexWrap="wrap">
                  <HoverAction onClick={() => command(item().enabled ? "pause" : "resume")}>
                    <text fg={theme.text.action.primary.base}>[p {item().enabled ? "Пауза" : "Включить"}]</text>
                  </HoverAction>
                  <HoverAction onClick={remove}>
                    <text fg={theme.text.feedback.error.base}>
                      [d {armed() === item().id ? "Точно удалить?" : "Удалить"}]
                    </text>
                  </HoverAction>
                  <HoverAction onClick={() => command("export")}>
                    <text fg={theme.text.action.primary.base}>[e Шаблон]</text>
                  </HoverAction>
                  <HoverAction onClick={() => limit()}>
                    <text fg={theme.text.muted}>[h Час]</text>
                  </HoverAction>
                  <HoverAction onClick={() => limit(true)}>
                    <text fg={theme.text.muted}>[j Сутки]</text>
                  </HoverAction>
                </box>
              </>
            )}
          </Show>
          <HoverAction onClick={enableChecked}>
            <text fg={theme.text.action.primary.base}>
              [a Включить проверенные триггеры ({Object.keys(checked()).length})]
            </text>
          </HoverAction>
          <Show when={notice()}>
            <text fg={theme.text.feedback.warning.base} wrapMode="word">
              {notice()}
            </text>
          </Show>
        </box>
      }
    />
  )
}
