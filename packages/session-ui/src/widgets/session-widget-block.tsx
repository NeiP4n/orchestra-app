import {
  createMemo,
  For,
  Match,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@orchestra/ui/icon"
import { Button } from "@orchestra/ui/button"
import { IconButton } from "@orchestra/ui/icon-button"
import {
  fieldValue,
  reply,
  treePath,
  type FieldKind,
  type Widget,
} from "@orchestra/ui/widgets"
import { tr } from "@orchestra/ui/widgets/i18n"
import { writeClipboard } from "../message/message-content"

export interface SessionWidgetBlockProps {
  id: string
  widget: Widget
  live: boolean
  onAnswer?: (outcome: { value: string; text: string }) => void
}

function sparkline(values: readonly number[]): string {
  const levels = " ▂▃▄▅▆▇█"
  const min = Math.min(...values)
  const max = Math.max(...values)
  return values.map((value) => levels[max > min ? Math.round(((value - min) / (max - min)) * 7) : 3]).join("")
}

export function SessionWidgetBlock(props: SessionWidgetBlockProps) {
  const answered = () => props.widget.answered !== undefined
  const disabled = () => !props.live || answered()

  const submit = (value: string) => {
    if (disabled()) return
    const text = reply(props.widget, value)
    props.onAnswer?.({ value, text })
  }

  return (
    <div
      data-component="session-widget-block"
      data-widget-kind={props.widget.kind}
      class="my-2 flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-base p-3 text-13-regular text-text-base shadow-sm"
    >
      <Show when={props.widget.title || props.widget.answered}>
        <div class="flex items-center justify-between gap-2 border-b border-border-subtle pb-2">
          <div class="flex items-center gap-1.5 font-medium text-text-strong">
            <Show when={answered()}>
              <span class="text-icon-success flex items-center">
                <Icon name="circle-check" size="small" />
              </span>
            </Show>
            <span>{props.widget.title || tr(props.widget.kind)}</span>
          </div>
          <Show when={props.widget.answered}>
            {(answer) => (
              <span class="text-12-regular text-text-muted">
                {tr("Answer chosen")}: <strong class="text-text-strong">{answer()}</strong>
              </span>
            )}
          </Show>
        </div>
      </Show>

      <Show
        when={!answered()}
        fallback={
          <div class="text-12-regular text-text-muted italic">
            ✓ {props.widget.answered}
          </div>
        }
      >
        <Switch>
          <Match when={props.widget.kind === "choice" ? (props.widget as Extract<Widget, { kind: "choice" }>) : undefined}>
            {(w) => <ChoiceWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "multi" ? (props.widget as Extract<Widget, { kind: "multi" }>) : undefined}>
            {(w) => <MultiWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "confirm" ? (props.widget as Extract<Widget, { kind: "confirm" }>) : undefined}>
            {(w) => <ConfirmWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "buttons" ? (props.widget as Extract<Widget, { kind: "buttons" }>) : undefined}>
            {(w) => <ButtonsWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "input" ? (props.widget as Extract<Widget, { kind: "input" }>) : undefined}>
            {(w) => <InputWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "form" ? (props.widget as Extract<Widget, { kind: "form" }>) : undefined}>
            {(w) => <FormWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "scale" ? (props.widget as Extract<Widget, { kind: "scale" }>) : undefined}>
            {(w) => <ScaleWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "table" ? (props.widget as Extract<Widget, { kind: "table" }>) : undefined}>
            {(w) => <TableWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "progress" ? (props.widget as Extract<Widget, { kind: "progress" }>) : undefined}>
            {(w) => <ProgressWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "steps" ? (props.widget as Extract<Widget, { kind: "steps" }>) : undefined}>
            {(w) => <StepsWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "diff" ? (props.widget as Extract<Widget, { kind: "diff" }>) : undefined}>
            {(w) => <DiffWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "code" ? (props.widget as Extract<Widget, { kind: "code" }>) : undefined}>
            {(w) => <CodeWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "kv" ? (props.widget as Extract<Widget, { kind: "kv" }>) : undefined}>
            {(w) => <KvWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "callout" ? (props.widget as Extract<Widget, { kind: "callout" }>) : undefined}>
            {(w) => <CalloutWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "tabs" ? (props.widget as Extract<Widget, { kind: "tabs" }>) : undefined}>
            {(w) => <TabsWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "rank" ? (props.widget as Extract<Widget, { kind: "rank" }>) : undefined}>
            {(w) => <RankWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "spark" ? (props.widget as Extract<Widget, { kind: "spark" }>) : undefined}>
            {(w) => <SparkWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "timeline" ? (props.widget as Extract<Widget, { kind: "timeline" }>) : undefined}>
            {(w) => <TimelineWidgetView widget={w()} />}
          </Match>
          <Match when={props.widget.kind === "tree" ? (props.widget as Extract<Widget, { kind: "tree" }>) : undefined}>
            {(w) => <TreeWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
          <Match when={props.widget.kind === "run" ? (props.widget as Extract<Widget, { kind: "run" }>) : undefined}>
            {(w) => <RunWidgetView widget={w()} disabled={disabled()} onSubmit={submit} />}
          </Match>
        </Switch>
      </Show>
    </div>
  )
}

function ChoiceWidgetView(props: {
  widget: Extract<Widget, { kind: "choice" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <For each={props.widget.items}>
        {(item, index) => (
          <button
            type="button"
            disabled={props.disabled}
            onClick={() => props.onSubmit(item.label)}
            class="flex items-center justify-between rounded-md border border-border-subtle bg-surface-raised px-3 py-2 text-left transition-colors hover:border-accent hover:bg-surface-hover active:bg-surface-active disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span class="flex items-center gap-2">
              <span class="text-11-medium text-text-muted">{index() + 1}.</span>
              <span class="font-medium text-text-strong">{item.label}</span>
            </span>
            <Show when={item.hint}>
              <span class="text-12-regular text-text-muted">{item.hint}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

function MultiWidgetView(props: {
  widget: Extract<Widget, { kind: "multi" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  const [state, setState] = createStore({
    on: [...props.widget.on],
  })

  const toggle = (index: number) => {
    if (props.disabled) return
    setState("on", index, (prev) => !prev)
  }

  const toggleAll = () => {
    if (props.disabled) return
    const all = state.on.every(Boolean)
    setState("on", state.on.map(() => !all))
  }

  const submit = () => {
    const chosen = props.widget.items.filter((_, i) => state.on[i]).map((it) => it.label)
    props.onSubmit(chosen.length ? chosen.join(", ") : tr("nothing"))
  }

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-col gap-1.5">
        <For each={props.widget.items}>
          {(item, index) => (
            <label
              class="flex cursor-pointer items-center justify-between rounded-md border border-border-subtle bg-surface-raised px-3 py-2 transition-colors hover:bg-surface-hover"
              classList={{ "opacity-50 cursor-not-allowed": props.disabled }}
            >
              <div class="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.on[index()]}
                  disabled={props.disabled}
                  onChange={() => toggle(index())}
                  class="h-4 w-4 rounded border-border-base accent-accent"
                />
                <span class="font-medium text-text-strong">{item.label}</span>
              </div>
              <Show when={item.hint}>
                <span class="text-12-regular text-text-muted">{item.hint}</span>
              </Show>
            </label>
          )}
        </For>
      </div>
      <div class="flex items-center justify-between gap-2 pt-1">
        <Button size="small" variant="ghost" disabled={props.disabled} onClick={toggleAll}>
          {state.on.every(Boolean) ? tr("Deselect all") : tr("Select all")}
        </Button>
        <Button size="small" variant="submit" disabled={props.disabled} onClick={submit}>
          {tr("[ Done ]")}
        </Button>
      </div>
    </div>
  )
}

function ConfirmWidgetView(props: {
  widget: Extract<Widget, { kind: "confirm" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  return (
    <div class="flex flex-col gap-2">
      <Show when={props.widget.text.length}>
        <div class="text-13-regular text-text-base">
          {props.widget.text.join("\n")}
        </div>
      </Show>
      <div class="flex items-center gap-2 pt-1">
        <Button size="small" variant="submit" disabled={props.disabled} onClick={() => props.onSubmit(props.widget.yes)}>
          {props.widget.yes}
        </Button>
        <Button size="small" variant="neutral" disabled={props.disabled} onClick={() => props.onSubmit(props.widget.no)}>
          {props.widget.no}
        </Button>
      </div>
    </div>
  )
}

function ButtonsWidgetView(props: {
  widget: Extract<Widget, { kind: "buttons" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <For each={props.widget.labels}>
        {(label, index) => (
          <Button
            size="small"
            variant="neutral"
            disabled={props.disabled}
            onClick={() => props.onSubmit(label)}
          >
            <span class="text-text-muted mr-1">{index() + 1}.</span> {label}
          </Button>
        )}
      </For>
    </div>
  )
}

function InputWidgetView(props: {
  widget: Extract<Widget, { kind: "input" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  const [state, setState] = createStore({ text: props.widget.text })

  const submit = () => {
    if (state.text.trim()) props.onSubmit(state.text.trim())
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      class="flex items-center gap-2"
    >
      <input
        type="text"
        value={state.text}
        placeholder={props.widget.placeholder || tr("type · Enter sends")}
        disabled={props.disabled}
        onInput={(e) => setState("text", e.currentTarget.value)}
        class="h-8 flex-1 rounded-md border border-border-base bg-surface-raised px-2.5 text-13-regular text-text-base focus:border-accent focus:outline-none disabled:opacity-50"
      />
      <Button size="small" variant="submit" disabled={props.disabled || !state.text.trim()} type="submit">
        {tr("[ Send ]")}
      </Button>
    </form>
  )
}

function FormWidgetView(props: {
  widget: Extract<Widget, { kind: "form" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  const [fields, setFields] = createStore(
    props.widget.fields.map((f) => ({
      label: f.label,
      kind: { ...f.kind },
    })),
  )

  const submit = () => {
    const formatted = fields.map((f) => `${f.label}=${fieldValue(f.kind as FieldKind)}`).join("; ")
    props.onSubmit(formatted)
  }

  return (
    <div class="flex flex-col gap-2.5">
      <For each={fields}>
        {(field, index) => (
          <div class="flex flex-col gap-1">
            <label class="text-12-medium text-text-muted">{field.label}</label>
            <Switch>
              <Match when={field.kind.type === "text" ? (field.kind as { type: "text"; value: string }) : undefined}>
                {(kind) => (
                  <input
                    type="text"
                    value={kind().value}
                    disabled={props.disabled}
                    onInput={(e) => setFields(index(), "kind", { type: "text", value: e.currentTarget.value })}
                    class="h-7 rounded-md border border-border-base bg-surface-raised px-2 text-13-regular text-text-base focus:border-accent focus:outline-none disabled:opacity-50"
                  />
                )}
              </Match>
              <Match when={field.kind.type === "number" ? (field.kind as { type: "number"; value: string }) : undefined}>
                {(kind) => (
                  <input
                    type="number"
                    value={kind().value}
                    disabled={props.disabled}
                    onInput={(e) => setFields(index(), "kind", { type: "number", value: e.currentTarget.value })}
                    class="h-7 rounded-md border border-border-base bg-surface-raised px-2 text-13-regular text-text-base focus:border-accent focus:outline-none disabled:opacity-50"
                  />
                )}
              </Match>
              <Match when={field.kind.type === "bool" ? (field.kind as { type: "bool"; value: boolean }) : undefined}>
                {(kind) => (
                  <label class="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={kind().value}
                      disabled={props.disabled}
                      onChange={(e) => setFields(index(), "kind", { type: "bool", value: e.currentTarget.checked })}
                      class="h-4 w-4 rounded border-border-base accent-accent"
                    />
                    <span class="text-13-regular">{kind().value ? tr("yes") : tr("no")}</span>
                  </label>
                )}
              </Match>
              <Match when={field.kind.type === "select" ? (field.kind as { type: "select"; options: readonly string[]; at: number }) : undefined}>
                {(kind) => (
                  <select
                    value={kind().at}
                    disabled={props.disabled}
                    onChange={(e) => setFields(index(), "kind", { ...kind(), at: Number(e.currentTarget.value) })}
                    class="h-7 rounded-md border border-border-base bg-surface-raised px-2 text-13-regular text-text-base focus:border-accent focus:outline-none disabled:opacity-50"
                  >
                    <For each={kind().options}>
                      {(opt, optIndex) => <option value={optIndex()}>{opt}</option>}
                    </For>
                  </select>
                )}
              </Match>
            </Switch>
          </div>
        )}
      </For>
      <div class="pt-1">
        <Button size="small" variant="submit" disabled={props.disabled} onClick={submit}>
          {tr("[ Send ]")}
        </Button>
      </div>
    </div>
  )
}

function ScaleWidgetView(props: {
  widget: Extract<Widget, { kind: "scale" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  const [state, setState] = createStore({ value: props.widget.value })

  const submit = () => {
    const val = props.widget.stars ? tr("{value} of {max}", { value: state.value, max: props.widget.max }) : String(state.value)
    props.onSubmit(val)
  }

  const numbers = createMemo(() => {
    const list: number[] = []
    for (let i = props.widget.min; i <= props.widget.max; i++) list.push(i)
    return list
  })

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={props.widget.stars}
        fallback={
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between text-12-regular text-text-muted">
              <span>{props.widget.low}</span>
              <span class="font-medium text-text-strong">{state.value}</span>
              <span>{props.widget.high}</span>
            </div>
            <input
              type="range"
              min={props.widget.min}
              max={props.widget.max}
              value={state.value}
              disabled={props.disabled}
              onInput={(e) => setState("value", Number(e.currentTarget.value))}
              class="w-full accent-accent disabled:opacity-50"
            />
          </div>
        }
      >
        <div class="flex items-center gap-1 text-20 leading-none">
          <For each={numbers()}>
            {(num) => (
              <button
                type="button"
                disabled={props.disabled}
                onClick={() => setState("value", num)}
                class="cursor-pointer text-accent hover:scale-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {num <= state.value ? "★" : "☆"}
              </button>
            )}
          </For>
          <span class="ml-2 text-13-regular text-text-muted">
            {state.value} / {props.widget.max}
          </span>
        </div>
      </Show>
      <div class="pt-1">
        <Button size="small" variant="submit" disabled={props.disabled} onClick={submit}>
          {tr("[ Done ]")}
        </Button>
      </div>
    </div>
  )
}

function TableWidgetView(props: {
  widget: Extract<Widget, { kind: "table" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  return (
    <div class="overflow-x-auto rounded border border-border-subtle">
      <table class="w-full border-collapse text-left text-13-regular">
        <Show when={props.widget.cols.length}>
          <thead class="bg-surface-raised border-b border-border-subtle font-medium text-text-strong">
            <tr>
              <For each={props.widget.cols}>
                {(col) => <th class="px-2.5 py-1.5">{col}</th>}
              </For>
            </tr>
          </thead>
        </Show>
        <tbody class="divide-y divide-border-subtle">
          <For each={props.widget.rows}>
            {(row) => (
              <tr
                onClick={() => {
                  if (props.widget.select && !props.disabled) props.onSubmit(row.join(" | "))
                }}
                class={
                  props.widget.select
                    ? "cursor-pointer transition-colors hover:bg-surface-hover active:bg-surface-active"
                    : ""
                }
              >
                <For each={row}>
                  {(cell) => <td class="px-2.5 py-1.5 text-text-base">{cell}</td>}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

function ProgressWidgetView(props: { widget: Extract<Widget, { kind: "progress" }> }) {
  return (
    <div class="flex flex-col gap-2">
      <For each={props.widget.items}>
        {(item) => (
          <div class="flex flex-col gap-1">
            <div class="flex items-center justify-between text-12-regular">
              <span class="font-medium text-text-strong">{item.label}</span>
              <span class="text-text-muted">{item.shown}</span>
            </div>
            <div class="h-2 w-full overflow-hidden rounded-full bg-surface-raised border border-border-subtle">
              <div
                class="h-full bg-accent transition-all duration-300"
                style={{ width: `${Math.round(item.fraction * 100)}%` }}
              />
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

function StepsWidgetView(props: { widget: Extract<Widget, { kind: "steps" }> }) {
  return (
    <div class="flex flex-col gap-1.5">
      <For each={props.widget.items}>
        {(item) => (
          <div class="flex items-center gap-2">
            <Switch>
              <Match when={item.state === "x"}>
                <span class="text-icon-success">
                  <Icon name="circle-check" size="small" />
                </span>
              </Match>
              <Match when={item.state === "~"}>
                <span class="text-icon-warning">
                  <Icon name="loader" size="small" class="animate-spin" />
                </span>
              </Match>
              <Match when={item.state === "!"}>
                <span class="text-icon-error">
                  <Icon name="circle-ban-sign" size="small" />
                </span>
              </Match>
              <Match when={true}>
                <span class="text-text-muted">○</span>
              </Match>
            </Switch>
            <span
              class="text-13-regular"
              classList={{
                "line-through text-text-muted": item.state === "x",
                "font-medium text-text-strong": item.state === "~",
                "text-text-error": item.state === "!",
              }}
            >
              {item.label}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

function DiffWidgetView(props: {
  widget: Extract<Widget, { kind: "diff" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  return (
    <div class="flex flex-col gap-2">
      <div class="max-h-60 overflow-y-auto rounded border border-border-subtle bg-surface-raised p-2 font-mono text-12-regular">
        <For each={props.widget.lines}>
          {(line) => (
            <div
              class="whitespace-pre"
              classList={{
                "text-text-success bg-surface-success/10": line.startsWith("+") && !line.startsWith("+++"),
                "text-text-error bg-surface-error/10": line.startsWith("-") && !line.startsWith("---"),
                "text-text-muted": !line.startsWith("+") && !line.startsWith("-"),
              }}
            >
              {line}
            </div>
          )}
        </For>
      </div>
      <div class="flex items-center gap-2 pt-1">
        <For each={props.widget.actions}>
          {(action) => (
            <Button
              size="small"
              variant={action === props.widget.actions[0] ? "submit" : "neutral"}
              disabled={props.disabled}
              onClick={() => props.onSubmit(action)}
            >
              {action}
            </Button>
          )}
        </For>
      </div>
    </div>
  )
}

function CodeWidgetView(props: { widget: Extract<Widget, { kind: "code" }> }) {
  const [state, setState] = createStore({ copied: false })

  const copy = async () => {
    const text = props.widget.lines.join("\n")
    if (await writeClipboard(text)) {
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    }
  }

  return (
    <div class="flex flex-col rounded border border-border-subtle bg-surface-raised">
      <div class="flex items-center justify-between border-b border-border-subtle px-3 py-1.5 text-12-regular text-text-muted">
        <span>{props.widget.lang || "code"}</span>
        <Button size="small" variant="ghost" onClick={copy}>
          <Icon name={state.copied ? "check" : "outline-copy"} size="small" />
          <span class="ml-1">{state.copied ? tr("Copied") : tr("Copy")}</span>
        </Button>
      </div>
      <pre class="overflow-x-auto p-3 font-mono text-12-regular text-text-base">
        {props.widget.lines.join("\n")}
      </pre>
    </div>
  )
}

function KvWidgetView(props: { widget: Extract<Widget, { kind: "kv" }> }) {
  return (
    <div class="flex flex-col divide-y divide-border-subtle rounded border border-border-subtle bg-surface-raised">
      <For each={props.widget.pairs}>
        {([k, v]) => (
          <div class="flex items-center justify-between px-3 py-1.5 text-13-regular">
            <span class="font-medium text-text-muted">{k}</span>
            <span class="text-text-strong font-mono">{v}</span>
          </div>
        )}
      </For>
    </div>
  )
}

function CalloutWidgetView(props: { widget: Extract<Widget, { kind: "callout" }> }) {
  const tone = () => props.widget.tone.toLowerCase()
  const icon = () => {
    if (["warn", "warning"].includes(tone())) return "warning" as const
    if (["error", "failed"].includes(tone())) return "circle-ban-sign" as const
    if (["ok", "done", "success"].includes(tone())) return "circle-check" as const
    return "help" as const
  }

  return (
    <div
      class="flex gap-2.5 rounded-md border p-3"
      classList={{
        "border-border-warning bg-surface-warning/10 text-text-warning": ["warn", "warning"].includes(tone()),
        "border-border-error bg-surface-error/10 text-text-error": ["error", "failed"].includes(tone()),
        "border-border-success bg-surface-success/10 text-text-success": ["ok", "done", "success"].includes(tone()),
        "border-border-subtle bg-surface-raised text-text-base": !["warn", "warning", "error", "failed", "ok", "done", "success"].includes(tone()),
      }}
    >
      <span class="mt-0.5 shrink-0">
        <Icon name={icon()} size="small" />
      </span>
      <div class="whitespace-pre-wrap text-13-regular">
        {props.widget.lines.join("\n")}
      </div>
    </div>
  )
}

function TabsWidgetView(props: { widget: Extract<Widget, { kind: "tabs" }> }) {
  const [state, setState] = createStore({ current: props.widget.current })

  return (
    <div class="flex flex-col gap-2">
      <div class="flex border-b border-border-subtle">
        <For each={props.widget.pages}>
          {(page, index) => (
            <button
              type="button"
              onClick={() => setState("current", index())}
              class="px-3 py-1.5 text-12-medium transition-colors"
              classList={{
                "border-b-2 border-accent text-accent font-medium": state.current === index(),
                "text-text-muted hover:text-text-base": state.current !== index(),
              }}
            >
              {page.name}
            </button>
          )}
        </For>
      </div>
      <div class="whitespace-pre-wrap text-13-regular text-text-base pt-1">
        {props.widget.pages[state.current]?.lines.join("\n")}
      </div>
    </div>
  )
}

function RankWidgetView(props: {
  widget: Extract<Widget, { kind: "rank" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  const [state, setState] = createStore({
    items: [...props.widget.items],
  })

  const move = (from: number, delta: number) => {
    const to = from + delta
    if (to < 0 || to >= state.items.length) return
    const next = [...state.items]
    const tmp = next[from]
    next[from] = next[to]
    next[to] = tmp
    setState("items", next)
  }

  const submit = () => {
    props.onSubmit(state.items.join(" > "))
  }

  return (
    <div class="flex flex-col gap-2">
      <div class="flex flex-col gap-1.5">
        <For each={state.items}>
          {(item, index) => (
            <div class="flex items-center justify-between rounded-md border border-border-subtle bg-surface-raised px-3 py-1.5 text-13-regular">
              <span class="flex items-center gap-2">
                <span class="text-11-medium text-text-muted">{index() + 1}.</span>
                <span class="font-medium text-text-strong">{item}</span>
              </span>
              <div class="flex items-center gap-1">
                <IconButton
                  icon={<span class="text-11">▲</span>}
                  size="small"
                  variant="ghost"
                  disabled={props.disabled || index() === 0}
                  onClick={() => move(index(), -1)}
                  aria-label="Move up"
                />
                <IconButton
                  icon={<span class="text-11">▼</span>}
                  size="small"
                  variant="ghost"
                  disabled={props.disabled || index() === state.items.length - 1}
                  onClick={() => move(index(), 1)}
                  aria-label="Move down"
                />
              </div>
            </div>
          )}
        </For>
      </div>
      <div class="pt-1">
        <Button size="small" variant="submit" disabled={props.disabled} onClick={submit}>
          {tr("[ Done ]")}
        </Button>
      </div>
    </div>
  )
}

function SparkWidgetView(props: { widget: Extract<Widget, { kind: "spark" }> }) {
  const min = () => Math.min(...props.widget.values)
  const max = () => Math.max(...props.widget.values)

  return (
    <div class="flex items-center gap-3">
      <span class="font-mono text-16 text-accent leading-none">
        {sparkline(props.widget.values)}
      </span>
      <span class="text-12-regular text-text-muted">
        {min()}…{max()} {props.widget.label ? `(${props.widget.label})` : ""}
      </span>
    </div>
  )
}

function TimelineWidgetView(props: { widget: Extract<Widget, { kind: "timeline" }> }) {
  return (
    <div class="flex flex-col gap-2 border-l-2 border-border-subtle pl-3 ml-1.5">
      <For each={props.widget.events}>
        {([when, what]) => (
          <div class="relative flex flex-col gap-0.5">
            <span class="absolute -left-[19px] top-1.5 h-2 w-2 rounded-full bg-accent" />
            <span class="text-11-medium text-accent font-mono">{when}</span>
            <span class="text-13-regular text-text-base">{what}</span>
          </div>
        )}
      </For>
    </div>
  )
}

function TreeWidgetView(props: {
  widget: Extract<Widget, { kind: "tree" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  return (
    <div class="flex flex-col gap-1 font-mono text-13-regular">
      <For each={props.widget.nodes}>
        {(node, index) => (
          <div
            onClick={() => {
              if (props.widget.select && !props.disabled) {
                props.onSubmit(treePath(props.widget.nodes, index()))
              }
            }}
            class="flex items-center gap-1.5 rounded py-0.5 px-1.5 transition-colors"
            classList={{
              "cursor-pointer hover:bg-surface-hover active:bg-surface-active text-text-strong font-medium": props.widget.select && !props.disabled,
              "text-text-base": !props.widget.select,
            }}
            style={{ "padding-left": `${node.depth * 16 + 6}px` }}
          >
            <span class="text-text-muted">└</span>
            <span>{node.label}</span>
          </div>
        )}
      </For>
    </div>
  )
}

function RunWidgetView(props: {
  widget: Extract<Widget, { kind: "run" }>
  disabled: boolean
  onSubmit: (val: string) => void
}) {
  const [copied, setCopied] = createStore<Record<number, boolean>>({})

  const copy = async (index: number, cmd: string) => {
    if (await writeClipboard(cmd)) {
      setCopied(index, true)
      setTimeout(() => setCopied(index, false), 2000)
    }
  }

  return (
    <div class="flex flex-col gap-1.5">
      <For each={props.widget.items}>
        {(item, index) => (
          <div class="flex items-center justify-between rounded-md border border-border-subtle bg-surface-raised px-3 py-2">
            <div class="flex flex-col gap-0.5 min-w-0">
              <span class="font-medium text-text-strong truncate">{item.label}</span>
              <span class="font-mono text-12-regular text-text-muted truncate">$ {item.command}</span>
            </div>
            <div class="flex items-center gap-1.5 shrink-0 ml-2">
              <Button
                size="small"
                variant="ghost"
                onClick={() => copy(index(), item.command)}
                aria-label="Copy command"
              >
                <Icon name={copied[index()] ? "check" : "outline-copy"} size="small" />
                <span class="ml-1">{copied[index()] ? tr("Copied") : tr("Copy")}</span>
              </Button>
              <Button
                size="small"
                variant="submit"
                disabled={props.disabled}
                onClick={() => props.onSubmit(tr("run `{command}`", { command: item.command }))}
              >
                ▶
              </Button>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
