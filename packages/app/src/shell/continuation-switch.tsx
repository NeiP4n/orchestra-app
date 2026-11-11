import { createContinuationControl, type ContinuationAccess } from "@orchestra/client/solid"
import { createMemo, createEffect, createRoot, on, Show } from "solid-js"
import { useLayout } from "@/shell/state/layout"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"

export function ContinuationSwitch(props: { access: ContinuationAccess }) {
  const control = createContinuationControl(props.access)

  return (
    <div data-slot="continuation-control" class="flex min-h-7 items-center gap-2 px-3 text-xs">
      <button
        type="button"
        role="switch"
        aria-label="Работа ИИ во всех проектах этого сервера"
        aria-checked={control.enabled() ?? false}
        aria-busy={control.busy()}
        disabled={control.busy() || control.enabled() === undefined}
        title="ВЫКЛ ставит все сессии на паузу сразу и после перезапуска. ВКЛ продолжает сохранённую работу."
        style={{ color: "var(--v2-text-text-base, inherit)" }}
        class="rounded px-2 py-1 text-v2-text-text-base hover:bg-v2-surface-surface-raised disabled:opacity-60"
        onClick={() => {
          void control.toggle()
        }}
      >
        {control.busy()
          ? "Приостанавливаем / продолжаем…"
          : control.enabled() === undefined
            ? "Работа ИИ: нет данных"
            : control.enabled()
              ? "▶ Работа ИИ: ВКЛ"
              : "Ⅱ Работа ИИ: ПАУЗА"}
      </button>
      <Show when={control.failed()}>
        <button
          type="button"
          onClick={() => {
            void control.refresh()
          }}
        >
          Не удалось обновить. Повторить
        </button>
      </Show>
    </div>
  )
}

export function ContinuationSwitchConnected() {
  const layout = useLayout(),
    global = useGlobal()

  const connection = createMemo(() => {
    const route = layout.route()
    const key = route.type === "session" ? route.server : layout.home.selection().server

    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  const context = useServerCtx(connection)

  return (
    <Show when={context()} keyed>
      {(ctx) => (
        <ContinuationSwitch
          access={{
            get: () => ctx.sdk.api.config.continuation.get(),
            set: (value) => ctx.sdk.api.config.continuation.set(value),
            onState: (receive) => ctx.sdk.event.on("config.continuation.updated", (event) => receive(event.data)),
            onReconnect: (refresh) => createRoot(dispose => {
              createEffect(on(ctx.sdk.connection.status, status => { if (status === "connected") refresh() }, { defer: true }))

              return dispose
            }),
          }}
        />
      )}
    </Show>
  )
}
