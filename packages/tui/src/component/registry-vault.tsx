import { createHoverFeedback } from "../ui/hover-feedback"
import { tint } from "../theme/color"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { CredentialVault } from "@orchestra/core/credential-vault/index"
import { HoverAction } from "./hover-action"
import { useTheme } from "../context/theme"
import { useT } from "../util/i18n"
import { Keymap } from "../context/keymap"

/** Operator-only local registry UI. No model tool exposes this collector. */
export function RegistryVault(props: { projectID?:string; sessionID?:string; access?: Pick<ReturnType<typeof CredentialVault.local>,"list"|"writeFromOperator"|"deleteFromOperator"> & Partial<Pick<ReturnType<typeof CredentialVault.local>,"bindFromOperator"|"slots"|"setAllowedSessionsFromOperator">> }) {
  const theme = useTheme().surface("dialog")
  const tr = useT()
  const cancelHover = createHoverFeedback()
  const vault = props.access ?? CredentialVault.local(props.projectID)
  const [entries, setEntries] = createSignal<Array<{ id: string; name: string; scope?:string; state?:string; allowedSessionIDs?:string[] }>>([])
  const [scope, setScope] = createSignal<CredentialVault.ScopeKind>(props.projectID ? "project" : "global")
  const [message, setMessage] = createSignal<() => string>(() => "")
  const [busy, setBusy] = createSignal(false)
  const [addHovered, setAddHovered] = createSignal(false)
  const [armed, setArmed] = createSignal<string>()
  const [cursor, setCursor] = createSignal(0)
  let pending: AbortController | undefined
  onCleanup(() => pending?.abort())
  const cancel = () => { pending?.abort(); setMessage(() => () => tr("Input cancelled. Entry not saved.")) }
  const refresh = async () => setEntries(vault.slots ? await vault.slots() : await vault.list())
  onMount(() => { void refresh().catch(() => setMessage(() => () => tr("Vault registry is unavailable. Changes are blocked."))) })
  const write = async (id?: string) => {
    if (busy()) return
    const controller = new AbortController(); pending = controller
    setBusy(true); setArmed(); setMessage(() => () => tr("Opening the Windows window (up to 30 seconds). If hidden: Alt+Tab. Esc to cancel."))
    try {
      const saved = await vault.writeFromOperator(id, controller.signal, (status) => setMessage(() => () => status ? tr("Windows: window {visible}, {foreground}. Alt+Tab \u2192 Orchestra Vault; Esc to cancel. SHOWN: {handle} @ {x},{y} {width}\u00d7{height}.", { visible: status.visible ? tr("visible") : tr("not visible"), foreground: status.foreground ? tr("foreground") : tr("not foreground"), handle: status.handle, x: status.x, y: status.y, width: status.width, height: status.height }) : tr("Windows reported the window is open. If hidden: Alt+Tab. Esc to cancel; timeout 120 seconds.")), id ? undefined : { name: "", site: "", scope: scope() })
      if (saved) { await refresh(); setMessage(() => () => tr("Saved. Variable names: {login}, {password}. Bind this entry to the current project without entering the secret again. Enable HTTP fill in this chat's Security settings; shell/env fill is not available.", { login: saved.variables.login, password: saved.variables.password })) }
      else setMessage(() => () => controller.signal.aborted ? tr("Input cancelled. Entry not saved.") : "")
    } catch (error) { setMessage(() => () => error instanceof Error && error.message === "Vault secure input timed out; no entry saved." ? tr("Window timed out after 120 seconds. Entry not saved.") : error instanceof Error && error.message === "Vault secure input window did not open; no entry saved." ? tr("The Windows window did not open within 30 seconds. Entry not saved.") : tr("The Vault window did not open or input failed. Entry not saved; Windows DPAPI is required.")) }
    finally { if (pending === controller) pending = undefined; setBusy(false) }
  }
  const grantCurrent = async (entry: { id:string; allowedSessionIDs?:string[] }, enabled: boolean) => {
    if (busy() || !props.sessionID || !vault.setAllowedSessionsFromOperator) return
    if (enabled && armed() !== `grant:${entry.id}`) { setArmed(`grant:${entry.id}`); setMessage(() => () => tr("Click again to confirm access for this chat. The value is not disclosed; HTTP OFF is enabled separately.")); return }
    setBusy(true)
    try {
      const allowed = (entry.allowedSessionIDs ?? []).filter((id) => id !== props.sessionID)
      await vault.setAllowedSessionsFromOperator(entry.id, enabled ? [...allowed, props.sessionID] : allowed, true)
      await refresh(); setMessage(() => () => enabled ? tr("This chat was added to the access list. The HTTP switch and tool permissions remain separate.") : tr("Access for this chat was revoked."))
    } catch { setMessage(() => () => tr("Access was not changed. Check the project and entry.")) }
    finally { setBusy(false); setArmed() }
  }
  const remove = async (id: string) => {
    if (busy()) return
    if (armed() !== id) { setArmed(id); return }
    setBusy(true)
    try { await vault.deleteFromOperator(id, true); await refresh(); setMessage(() => () => tr("Entry deleted.")) }
    catch { setMessage(() => () => tr("Entry not deleted. Registry is unavailable.")) }
    finally { setArmed(); setBusy(false) }
  }
  Keymap.createLayer(() => ({ mode: "modal", commands: [
    ...(busy() ? [{ bind: "escape", title: tr("Cancel Vault input"), group: "Vault", run: cancel }] : []),
    { bind: "ctrl+g", title: tr("New global entry"), group: "Vault", run: () => { if (!busy()) setScope("global") } },
    ...(props.projectID ? [{ bind: "ctrl+l", title: tr("New project entry"), group: "Vault", run: () => { if (!busy()) setScope("project") } }] : []),
    { bind: "ctrl+n", title: tr("Add Vault entry"), group: "Vault", run: () => void write() },
    { bind: "up", title: tr("Previous entry"), group: "Vault", run: () => { setArmed(); setCursor((value) => Math.max(0, value - 1)) } },
    { bind: "down", title: tr("Next entry"), group: "Vault", run: () => { setArmed(); setCursor((value) => Math.min(Math.max(0, entries().length - 1), value + 1)) } },
    { bind: "return", title: tr("Replace Vault entry"), group: "Vault", run: () => { const entry = entries()[cursor()]; if (entry) void write(entry.id) } },
    { bind: "ctrl+d", title: tr("Confirm deleting Vault entry"), group: "Vault", run: () => { const entry = entries()[cursor()]; if (entry) void remove(entry.id) } },
  ] }))
  return <box flexDirection="column" gap={1}>
    <text fg={theme.text.muted} wrapMode="word">{tr("Windows DPAPI · input in a separate window · AI sees names, not values. Enter API keys or tokens in the masked Password field. Processes under your user account are not isolated.")}</text>
    <box flexDirection="row" gap={2}>
      <Show when={props.projectID}><box id="registry-vault.scope-project" onMouseUp={() => { if (!busy()) setScope("project") }}><text fg={theme.text.base}>{scope() === "project" ? tr("[●] This project only") : tr("[ ] This project only")}</text></box></Show>
      <box id="registry-vault.scope-global" onMouseUp={() => { if (!busy()) setScope("global") }}><text fg={theme.text.base}>{scope() === "global" ? tr("[●] All projects") : tr("[ ] All projects")}</text></box>
    </box>
    <text fg={theme.text.muted} wrapMode="word">{tr("New entry:")} {scope() === "global" ? tr("global, visible in every project") : tr("local, this project only")}. {tr("Chat access is granted separately; AI does not receive the value.")}</text>
    <box alignItems="flex-start">
      <box id="registry-vault.add" border borderStyle="rounded" borderColor={theme.text.action.primary.base}
        paddingLeft={1} paddingRight={1} flexShrink={0}
        backgroundColor={addHovered() && !busy() ? tint(theme.background.base, theme.text.base, 0.12) : theme.background.base}
        onMouseOver={() => setAddHovered(true)} onMouseOut={() => setAddHovered(false)}
        onMouseDown={(event) => event.stopPropagation()}
        onMouseUp={(event) => { event.stopPropagation(); if (!busy()) void write() }}>
        <text fg={theme.text.base} wrapMode="none">{busy() ? tr("Waiting for window…") : tr("+ Add entry")}</text>
      </box>
    </box>
    <Show when={busy()}><box id="registry-vault.cancel" backgroundColor={cancelHover.background()} onMouseOver={cancelHover.onMouseOver} onMouseOut={cancelHover.onMouseOut} onMouseDown={(event) => event.stopPropagation()} onMouseUp={(event) => { event.stopPropagation(); cancel() }}><text fg={theme.text.action.primary.base}>{tr("[ Cancel (Esc) ]")}</text></box></Show>
    <Show when={entries().length === 0}><text fg={theme.text.muted}>{tr("No entries")}</text></Show>
    <For each={entries()}>{(entry, index) => <box flexDirection="row" gap={1}>
      <text fg={theme.text.base}>{`${cursor() === index() ? "› " : "  "}${entry.name} · ${entry.scope === "global" ? tr("all projects") : entry.scope === "project" ? tr("project") : "legacy"}${entry.state === "empty" ? tr(" · empty") : ""}`}</text>
      <box flexGrow={1} />
      <Show when={props.projectID&&vault.bindFromOperator&&(!entry.scope||entry.scope==="legacy")}><HoverAction disabled={busy()} onClick={()=>{setBusy(true);void vault.bindFromOperator!(entry.id,props.projectID!).then(()=>setMessage(() => () => tr("Name allowed for this project. HTTP stays OFF until enabled in this chat's Security settings."))).catch(()=>setMessage(() => () => tr("Binding not saved: check the name and project."))).finally(()=>setBusy(false))}}><text fg={theme.text.muted}>{tr("Allow project")}</text></HoverAction></Show>
      <Show when={props.sessionID && vault.setAllowedSessionsFromOperator}><HoverAction id={`registry-vault.grant-${entry.id}`} disabled={busy()} onClick={() => void grantCurrent(entry, !entry.allowedSessionIDs?.includes(props.sessionID!))}><text fg={theme.text.action.primary.base}>{entry.allowedSessionIDs?.includes(props.sessionID!) ? tr("Revoke chat") : armed() === `grant:${entry.id}` ? tr("Confirm chat?") : tr("Chat access")}</text></HoverAction></Show>
      <HoverAction disabled={busy()} onClick={() => void write(entry.id)}><text fg={theme.text.muted}>{entry.state === "empty" ? tr("Fill") : tr("Replace")}</text></HoverAction>
      <HoverAction disabled={busy()} onClick={() => void remove(entry.id)}><text fg={theme.text.feedback.warning.base}>{armed() === entry.id ? tr("Confirm deletion?") : tr("Delete")}</text></HoverAction>
    </box>}</For>
    <Show when={message()()}><text fg={theme.text.muted} wrapMode="word">{message()()}</text></Show>
    <text fg={theme.text.muted} wrapMode="word">{tr("Ctrl+G global · Ctrl+L local. Press Enter to fill an empty entry.")}</text>
    <text fg={theme.text.muted} wrapMode="word">{tr("Ctrl+N add · Enter replace · Ctrl+D twice to delete.")}</text>
  </box>
}
