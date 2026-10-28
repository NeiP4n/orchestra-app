import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { RGBA, TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
} from "@orchestra/client"
import { Spinner } from "../../component/spinner"
import { SculkResonanceSpinner, SculkPixelStreamTail } from "../../component/sculk-effects"
import { createSyntaxStyleMemo, useTheme, useThemes } from "../../context/theme"
import { reasoningSummary } from "../../context/thinking"
import { usePlugin } from "../../plugin/context"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { use } from "./render-context"
import { generateThinkingSyntax } from "./thinking-syntax"
import { canonicalToolName } from "../../util/tool-display"
import { Federation } from "@orchestra/schema/federation"
import { ReplyOptions } from "./society"
import { WidgetBlock } from "./widgets"
import { parse, type Widget } from "../../widgets/parse"
import { useData } from "../../context/data"

export const INLINE_TOOL_ICON_WIDTH = 2

const toolDisplays = new Set([
  "shell",
  "hub",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "subagent",
  "execute",
  "patch",
  "question",
  "skill",
  "note",
])

export function toolDisplay(tool: string) {
  const normalized = canonicalToolName(tool)
  return toolDisplays.has(normalized) ? normalized : "generic"
}

export function ReasoningPart(props: {
  last: boolean
  part: SessionMessageAssistantReasoning
  message: SessionMessageAssistant
}) {
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const thinkingSyntax = createSyntaxStyleMemo(() => generateThinkingSyntax(syntax(), theme.text.muted))
  const ctx = use()
  // Collapsed by default in hide mode: a single line throughout, so the
  // layout never shifts. Click to open the full markdown block, click to close.
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => reasoningContent(props.part))
  const isDone = createMemo(
    () => props.part.time?.completed !== undefined || props.message.time.completed !== undefined,
  )
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time?.completed ?? props.message.time.completed
    const start = props.part.time?.created ?? props.message.time.created
    return end === undefined ? 0 : Math.max(0, end - start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const toggle = () => {
    if (!inMinimal()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content()}>
      <box paddingLeft={3} flexDirection="column" flexShrink={0}>
        <box
          border={!inMinimal() || expanded() ? ["left"] : undefined}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.decrease(theme.background.base)}
          paddingLeft={!inMinimal() || expanded() ? 1 : 0}
        >
          <box onMouseUp={toggle}>
            <ReasoningHeader
              toggleable={inMinimal()}
              open={!inMinimal() || expanded()}
              done={isDone()}
              title={inMinimal() && !expanded() ? summary().title : null}
              duration={isDone() ? Locale.duration(duration()) : undefined}
            />
          </box>
        </box>
        <Show when={!inMinimal() || expanded()}>
          <box marginTop={1}>
            <box
              border={["left"]}
              customBorderChars={SplitBorder.customBorderChars}
              borderColor={theme.decrease(theme.background.base)}
              paddingLeft={inMinimal() ? 3 : 1}
            >
              <code
                filetype="markdown"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={thinkingSyntax()}
                content={content()}
                conceal={ctx.markdownMode() === "rendered"}
                fg={theme.text.muted}
              />
            </box>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export function reasoningContent(part: SessionMessageAssistantReasoning) {
  // OpenRouter encrypts some reasoning blocks; drop the placeholder.
  return part.text.replace("[REDACTED]", "").trim()
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
}) {
  const theme = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(
          theme.text.feedback.warning.base.r,
          theme.text.feedback.warning.base.g,
          theme.text.feedback.warning.base.b,
          0.6,
        )
      : theme.text.feedback.warning.base

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row">
          <SculkResonanceSpinner color={fg()}>{props.title ? "Thinking: " + props.title : "Thinking"}</SculkResonanceSpinner>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} wrapMode="none">
          <Show when={props.toggleable}>
            <span>{props.open ? "- " : "+ "}</span>
          </Show>
          <span>Thought</span>
          <Show when={props.title || props.duration}>
            <span>: </span>
          </Show>
          <Show when={props.title}>
            <span>{props.title}</span>
          </Show>
          <Show when={props.duration}>
            <span>
              {props.title ? " · " : ""}
              {props.duration}
            </span>
          </Show>
        </text>
      </Match>
    </Switch>
  )
}

export function TextPart(props: {
  last: boolean
  part: SessionMessageAssistantText
  message: SessionMessageAssistant
}) {
  const ctx = use()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const plugins = usePlugin()
  // Quick replies the assistant offered end the message; they are drawn as buttons, not prose.
  const reply = createMemo(() => Federation.parseReplyOptions(props.part.text.trim()))
  const data = useData()
  const finished = () => props.message.time.completed !== undefined
  // Only the newest exchange still waits for an answer; older offers stay visible but inert. System
  // notes, reminders and switches land after the answer without replying to it, so only a later
  // user or assistant message settles it (checking for the very last message left most offers dead).
  const latest = () => {
    const list = data.session.message.list(ctx.sessionID)
    const at = list.findIndex((message) => message.id === props.message.id)
    return at >= 0 && !list.slice(at + 1).some((message) => message.type === "user" || message.type === "assistant")
  }
  // Interactive elements (`@ui ... @end`) are cut out of the prose once the message is complete;
  // while it streams the text is shown as written so nothing flickers into a half-built element.
  const segments = createMemo(() => (finished() ? parse(reply().body) : [{ type: "text" as const, text: reply().body }]))
  // What the person did with each element: kept here so a re-render does not forget an answer.
  const [changed, setChanged] = createSignal<Record<number, Widget>>({})
  const dimensions = useTerminalDimensions()
  return (
    <Show when={props.part.text.trim()}>
      <For each={segments()}>
        {(segment, index) => (
          <Show
            when={segment.type === "widget" ? segment : undefined}
            fallback={
              <Show when={segment.type === "text" && segment.text.trim()}>
                {/* The conversation's nerve runs in the left gutter beside the answer (see TranscriptAxon). */}
                <box paddingLeft={3} flexShrink={0}>
                  {/* Configure custom nodes before parsing; apply content before streaming so completion keeps the final tokens. */}
                  <markdown
                    syntaxStyle={syntax()}
                    renderNode={plugins.markdown()}
                    content={segment.type === "text" ? segment.text.trim() : ""}
                    streaming={props.message.time.completed === undefined}
                    internalBlockMode="top-level"
                    tableOptions={{ style: "grid", cellPaddingX: 1 }}
                    conceal={ctx.markdownMode() === "rendered"}
                    fg={theme.markdown.text}
                    bg={theme.background.base}
                  />
                  <Show when={props.message.time.completed === undefined}>
                    <SculkPixelStreamTail active={true} />
                  </Show>
                </box>
              </Show>
            }
          >
            {(found) => (
              <WidgetBlock
                id={`${props.message.id}:${props.part.text.slice(0, 24)}:${index()}`}
                widget={changed()[index()] ?? found().widget}
                width={Math.max(24, dimensions().width - 8)}
                live={latest()}
                onChange={(next) => setChanged((all) => ({ ...all, [index()]: next }))}
              />
            )}
          </Show>
        )}
      </For>
      <Show when={finished() && reply().options.length > 0}>
        <ReplyOptions options={reply().options} settled={!latest()} />
      </Show>
    </Show>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: string
  failure?: string
  spinner?: boolean
  status?: JSX.Element
  children: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: () => void
}) {
  return (
    <box paddingLeft={3} onMouseOver={props.onMouseOver} onMouseOut={props.onMouseOut} onMouseUp={props.onMouseUp}>
      <Switch>
        <Match when={props.spinner}>
          <Show when={props.status} fallback={<Spinner color={props.color} children={props.children} />}>
            {(status) => (
              <box flexDirection="row" gap={1}>
                <Spinner color={props.color} />
                <InlineToolLabel color={props.color} status={status()}>
                  {props.children}
                </InlineToolLabel>
              </box>
            )}
          </Show>
        </Match>
        <Match when={true}>
          <Show fallback={<Spinner color={props.color}>{props.pending}</Spinner>} when={props.complete || props.failed}>
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <Show
                when={props.status}
                fallback={
                  <text
                    flexGrow={1}
                    fg={props.failed ? props.errorColor : props.color}
                    attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
                  >
                    {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
                  </text>
                }
              >
                {(status) => (
                  <InlineToolLabel
                    color={props.failed ? props.errorColor : props.color}
                    denied={props.denied}
                    status={status()}
                  >
                    {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
                  </InlineToolLabel>
                )}
              </Show>
            </box>
          </Show>
        </Match>
      </Switch>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

function InlineToolLabel(props: { color?: RGBA; denied?: boolean; status: JSX.Element; children: JSX.Element }) {
  return (
    <box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1}>
      <text
        maxWidth="100%"
        flexShrink={0}
        fg={props.color}
        attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
      >
        {props.children}
      </text>
      {props.status}
    </box>
  )
}
