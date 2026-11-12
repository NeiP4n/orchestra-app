import { browserChat, removeBrowserChat } from "../util/browser-chat-lifecycle"
import { ensureImportedBrowsers, type ImportedBrowsers } from "../util/project-template-browsers"
import { BrowserRuntime } from "@orchestra/core/browser/runtime"
import { BrowserLifecycle } from "@orchestra/core/browser/lifecycle"
import {
  isNoteConflictError,
  type NoteInfo,
  type NoteLength,
  type NoteStatus,
  type PermissionRuleset,
} from "@orchestra/client"
import { Note } from "@orchestra/schema/note"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { errorMessage } from "../util/error"
import { useClient } from "./client"
import { useData } from "./data"
import { useProjects } from "./projects"
import { createSimpleContext } from "./helper"
import { useRoute } from "./route"
import { useStorage } from "./storage"
import {
  addBrowserSession,
  adoptBrowserChat,
  collapseDuplicateChats,
  bindBrowserChat,
  browserChatRecord,
  emptyBrowserSessions,
  forgetClosedBrowserSession,
  groupBrowserSession,
  forgetBrowserChat,
  retireDeletedBrowserChat,
  removeBrowserSession,
  reopenBrowserSession,
  renameBrowserSession,
  selectBrowserSession,
  type BrowserSession,
  type BrowserSessionsState,
} from "../util/browser-sessions"

export type NotesTab = "projects" | "notes" | "console" | "browser"

type Listing = { notes: NoteInfo[]; error?: string }

// Notes of every directory a view asked for, kept fresh from the note.updated
// events of the server so a note the AI is writing updates while it is open.
// The left panel tab and the note-or-chat choice per session live here too,
// because the panel, the session frame and the commands all read them.
export const { use: useNotes, provider: NotesProvider } = createSimpleContext({
  name: "Notes",
  init: () => {
    const client = useClient()
    const data = useData()
    const projects = useProjects()
    const route = useRoute()
    const [panel, updatePanel] = useStorage().store<{ tab?: NotesTab; project?: string; collapsed?: Record<string, boolean> }>("notes-panel", {
      initial: {},
    })
    // The browser sessions of each project (the Browser view), kept across restarts.
    const [browser, updateBrowser] = useStorage().store<BrowserSessionsState>("browser-sessions", {
      initial: emptyBrowserSessions(),
    })
    const changeBrowser = (mutation: (draft: BrowserSessionsState) => void) =>
      updateBrowser((draft) => {
        draft.projects ??= {}
        draft.selected ??= {}
        mutation(draft)
        // One chat, one browser session: a duplicate record of the same chat is folded into the oldest.
        collapseDuplicateChats(draft)
        BrowserLifecycle.publish(Object.values(draft.retiredChats ?? {}).flat(), Object.values(draft.projects).flatMap((items) => items.flatMap((item) => item.chat ? [item.chat] : [])))
      }).catch((error) => {
        console.error("Browser session changes could not be saved; no successful change was recorded.", error)
      })
    createEffect(() => {
      try { BrowserLifecycle.publish(Object.values(browser.retiredChats ?? {}).flat(), Object.values(browser.projects ?? {}).flatMap((items) => items.flatMap((item) => item.chat ? [item.chat] : []))) }
      catch (error) { console.error("Browser lifecycle projection failed", error) }
    })
    // This projection belongs to the owning store, not a SessionFrame that can unmount
    // during chat deletion. A loaded empty roster is authoritative, even just after boot.
    createEffect(() => {
      if (!projects.loaded()) return
      try {
        const list = projects.list()
        for (const project of list) {
          const selected = browser.selected?.[project.id]
          BrowserRuntime.publishSelection(project.directory, selected)
        }
        BrowserRuntime.publishSessions(list.flatMap(project =>
          (browser.projects?.[project.id] ?? []).map(item => ({
            id: item.id, name: item.name, project: project.directory, projectID: project.id,
            ...(item.group ? { group: item.group } : {}),
            ...(item.chat ? { chat: item.chat } : {}),
          }))), { authoritative: true })
      } catch (error) {
        console.error("Browser session projection could not be published", error)
      }
    })
    const importedProjects = new Set<string>()
    const hydrateImportedProjects = () => {
      for (const project of projects.list()) {
        if (importedProjects.has(project.id)) continue
        importedProjects.add(project.id)
        void client.api.orchestra.projectTemplate.browsers({projectID:project.id})
          .then(async input => { if(input) { await updateBrowser(draft => ensureImportedBrowsers(draft,input)); await client.api.orchestra.projectTemplate.finishCreate({token:input.importID}) } })
          .catch(error => { importedProjects.delete(project.id); console.error("Imported browser definitions could not be loaded",error) })
      }
    }
    createEffect(hydrateImportedProjects)
    onCleanup(client.event.on("server.connected", () => { importedProjects.clear(); hydrateImportedProjects() }))
    // Chats a browser session is being given or adopted right now: the instant the chat exists it is claimed, so the
    // adoption of "orphan" browser chats never takes the one the button is still binding.
    const claimed = new Set<string>()
    // Heals duplicates made before this fix, once.
    void changeBrowser(() => {})
    // Sessions whose bound note the user put aside to read the full chat.
    const [chat, setChat] = createStore<Record<string, boolean>>({})
    const [listings, setListings] = createStore<Record<string, Listing>>({})
    // The "new note" field of the panel, opened by its button or by the palette.
    const [creating, setCreating] = createSignal(false)
    const requested = new Set<string>()
    const inflight = new Set<string>()
    // A write that lands while a listing is in flight must not be lost, so it re-reads once more.
    const stale = new Set<string>()

    const load = (directory: string) => {
      requested.add(directory)
      if (inflight.has(directory)) return void stale.add(directory)
      inflight.add(directory)
      void client.api.note
        .list({ location: { directory } })
        .then(
          (result) => setListings(directory, { notes: [...result.data], error: undefined }),
          (error: unknown) =>
            setListings(directory, { notes: listings[directory]?.notes ?? [], error: errorMessage(error) }),
        )
        .finally(() => {
          inflight.delete(directory)
          if (stale.delete(directory)) load(directory)
        })
    }

    const reloadAll = () => [...requested].forEach(load)

    onCleanup(
      client.event.on("note.updated", (event) => {
        const matching = [...requested].filter((directory) => directory === event.location?.directory)
        // The event names the location the server resolved; when it is not one this client keys
        // its listings by, every listing re-reads rather than miss the change.
        ;(matching.length ? matching : [...requested]).forEach(load)
      }),
    )
    onCleanup(client.event.on("server.connected", reloadAll))

    const upsert = (directory: string, note: NoteInfo) =>
      setListings(
        produce((draft) => {
          const listing = draft[directory] ?? { notes: [] }
          listing.notes = [note, ...listing.notes.filter((item) => item.name !== note.name)]
          draft[directory] = listing
        }),
      )

    const list = (directory: string) => {
      if (!requested.has(directory)) {
        requested.add(directory)
        queueMicrotask(() => load(directory))
      }
      return listings[directory]?.notes ?? []
    }

    const bound = (sessionID: string) => {
      const session = data.session.get(sessionID)
      if (!session) return
      // Newest first, like the server's own binding lookup when several notes claim a chat.
      return list(session.location.directory).find((note) => note.frontmatter.session === sessionID)
    }

    // Metadata changes carry intent, not text, so a note the AI rewrote meanwhile
    // takes the change on top of its latest version instead of refusing it.
    const update = async (
      directory: string,
      note: NoteInfo,
      patch: { title?: string; status?: NoteStatus; tags?: string[]; length?: NoteLength },
    ) => {
      const location = { directory }
      const result = await client.api.note
        .update({ location, name: note.name, ...patch, expectedMtime: note.mtime })
        .catch(async (error: unknown) => {
          if (!isNoteConflictError(error)) throw error
          const latest = await client.api.note.get({ location, name: note.name })
          return client.api.note.update({ location, name: note.name, ...patch, expectedMtime: latest.data.mtime })
        })
      upsert(directory, result.data)
      return result.data
    }

    const link = async (directory: string, note: NoteInfo, session: string | undefined) => {
      const previous = note.frontmatter.session
      const result = await client.api.note.link({
        location: { directory },
        name: note.name,
        session,
        expectedMtime: note.mtime,
      })
      upsert(directory, result.data)
      // A chat that loses the note becomes an ordinary chat again: the rules that
      // bound it to the note must not outlive the binding.
      if (previous && previous !== session) await release(previous)
      return result.data
    }

    // The chat of a note is its canvas: it names the note in its metadata. The rules
    // that restrict it to the note live on the `notes` agent itself, so the session
    // carries none: a session-level `deny *` would also strip the `read` and `shell`
    // tools the agent keeps listed for the opencode.ai free tier, which rejects any
    // request without them.
    const scoped: PermissionRuleset = []

    const scope = async (sessionID: string, note: NoteInfo) => {
      const current = data.session.get(sessionID)
      const bound = Note.chatOf(current?.metadata) === note.name
      const locked = sameRules(current?.permissions, scoped)
      if (current?.agent !== Note.agent) await client.api.session.switchAgent({ sessionID, agent: Note.agent })
      if (bound && locked) return
      await client.api.session.update({
        sessionID,
        metadata: Note.chatMetadata(note.name),
        permissions: scoped,
      })
      const session = await client.api.session.get({ sessionID }).catch(() => undefined)
      if (session) data.session.remember(session)
    }

    const release = async (sessionID: string) => {
      const current = data.session.get(sessionID)
      if (!current || !sameRules(current.permissions, scoped)) return
      await client.api.session.update({ sessionID, permissions: [] })
      const session = await client.api.session.get({ sessionID }).catch(() => undefined)
      if (session) data.session.remember(session)
    }

    const setTab = (tab: NotesTab) => void updatePanel((draft) => void (draft.tab = tab)).catch(() => undefined)

    // The chat of a note is the session its frontmatter names. A note without one, or
    // whose session is gone, gets a new session in its directory bound to it, so the
    // AI of that chat writes into the note from the first prompt.
    const open = async (directory: string, note: NoteInfo) => {
      const sessionID = (await existingSession(note.frontmatter.session)) ?? (await bindNewSession(directory, note))
      await scope(sessionID, note)
      setChat(sessionID, false)
      setTab("notes")
      route.navigate({ type: "session", sessionID })
    }

    // A new note starts with its own chat, so the first prompt already writes into it.
    const start = async (directory: string, title: string) => {
      const created = data.session.create({ title, location: { directory }, agent: Note.agent })
      await created.request
      const result = await client.api.note.create({ location: { directory }, title, session: created.id })
      upsert(directory, result.data)
      await scope(created.id, result.data)
      setChat(created.id, false)
      setTab("notes")
      route.navigate({ type: "session", sessionID: created.id })
    }

    const existingSession = async (sessionID: string | undefined) => {
      if (!sessionID) return
      if (data.session.get(sessionID)) return sessionID
      const session = await client.api.session.get({ sessionID }).catch(() => undefined)
      if (!session) return
      data.session.remember(session)
      return sessionID
    }

    const bindNewSession = async (directory: string, note: NoteInfo) => {
      const created = data.session.create({
        title: note.frontmatter.title || note.name,
        location: { directory },
        agent: Note.agent,
      })
      await created.request
      await link(directory, note, created.id)
      return created.id
    }

    // Rules compare by value, so the check does not depend on the server echoing
    // them back in the same order.
    const sameRules = (current: PermissionRuleset | undefined, rules: PermissionRuleset) =>
      current?.length === rules.length &&
      current.every(
        (rule, index) =>
          rule.action === rules[index]!.action &&
          rule.resource === rules[index]!.resource &&
          rule.effect === rules[index]!.effect,
      )

    // One browser session, one BrowserAgent: an empty chat of the browser-agent role in the project's folder,
    // titled like the session. The chat id is kept with the session so reopening it brings the same chat back.
    // A session being given its chat is not given a second one by a click that lands before the first finishes.
    const agentPending = new Set<string>()
    const giveBrowserAgent = async (projectID: string, sessionID: string, directory: string, title: string) => {
      if (agentPending.has(sessionID) || browser.projects?.[projectID]?.find((entry) => entry.id === sessionID)?.chat) return
      agentPending.add(sessionID)
      try {
        const created = data.session.create({ title, location: { directory }, agent: "team-browser-agent" })
        claimed.add(created.id)
        await projects.claim(created.id, projectID, created.request)
        await changeBrowser((draft) => void bindBrowserChat(draft, projectID, sessionID, created.id))
        return created.id
      } catch {
        // The browser works without its chat; the next open tries again.
      } finally {
        agentPending.delete(sessionID)
      }
    }

    const tab = () => panel.tab ?? "projects"

    return {
      tab,
      setTab,
      browserChatRecord: (chat: string) => browserChatRecord(browser, chat),
      // Unlike changeBrowser, this strict path propagates persistence failures to import recovery.
      importBrowserDefinitions: (input: ImportedBrowsers) => updateBrowser(draft => ensureImportedBrowsers(draft,input)),
      browserSessions: (projectID: string): readonly BrowserSession[] => browser.projects?.[projectID] ?? [],
      browserSelected: (projectID: string) => {
        const id = browser.selected?.[projectID]
        return browser.projects?.[projectID]?.find((item) => item.id === id)
      },
      addBrowserSession: (projectID: string, directory?: string) => {
        const id = `brw_${crypto.randomUUID()}`
        let title = "Browser"
        const added = changeBrowser((draft) => {
          title = addBrowserSession(draft, projectID, { id, now: Date.now() })?.name ?? title
        })
        if (directory) void added.then(() => giveBrowserAgent(projectID, id, directory, title))
      },
      // A session that has no BrowserAgent yet (made before BrowserAgent existed) gets one the first time it is opened.
      ensureBrowserAgent: async (projectID: string, id: string, directory: string) => {
        const item = browser.projects?.[projectID]?.find((entry) => entry.id === id)
        if (!item) return
        if (item.chat) {
          const chatID = item.chat
          // The cache can be stale after a crash or deletion on another client.
          const session = await browserChat(() => client.api.session.get({ sessionID: chatID }))
          if (session) {
            const owners = await client.api.orchestra.owner.list()
            if (session.parentID || owners[chatID] !== projectID)
              throw new Error("Browser chat does not belong to this project's top-level sessions")
            if (session.agent !== "team-browser-agent")
              await client.api.session.switchAgent({ sessionID: chatID, agent: "team-browser-agent" })
            return chatID
          }
          await changeBrowser(draft => {
            const current = draft.projects[projectID]?.find(entry => entry.id === id)
            if (current?.chat === chatID) delete current.chat
          })
          data.session.evict(chatID)
        }
        return giveBrowserAgent(projectID, id, directory, item.name)
      },
      removeBoundBrowserChat: async (projectID: string, chatID: string) => {
        const session = await browserChat(() => client.api.session.get({sessionID:chatID}))
        if (!session) return
        const owners = await client.api.orchestra.owner.list()
        if (session.parentID || owners[chatID] !== projectID)
          throw new Error("Browser chat does not belong to this project's top-level sessions")
        await removeBrowserChat(() => client.api.session.remove({sessionID:chatID}))
      },
      closedBrowserSessions: (projectID: string) => browser.closed?.[projectID] ?? [],
      reopenBrowserSession: (projectID: string, id: string) =>
        changeBrowser((draft) => void reopenBrowserSession(draft, projectID, id)),
      forgetClosedBrowserSession: (projectID: string, id: string) =>
        changeBrowser((draft) => forgetClosedBrowserSession(draft, projectID, id)),
      removeBrowserSession: (projectID: string, id: string) =>
        changeBrowser((draft) => removeBrowserSession(draft, projectID, id)),
      // A browser chat the Orchestrator made becomes a real browser session of the project (a page, a profile, its chat).
      claimedChat: (chat: string) => claimed.has(chat),
      retiredBrowserChat: (projectID: string, chat: string) => browser.retiredChats?.[projectID]?.includes(chat) ?? false,
      adoptBrowserChat: (projectID: string, chat: string, name: string) => {
        // Imported BrowserAgents must retain the server-reserved browser ID. Their
        // owning-store hydration, not legacy orphan adoption, supplies that binding.
        if (typeof data.session.get(chat)?.metadata?.["orchestra:template-import"] === "string") return Promise.resolve()

        if (claimed.has(chat)) return
        claimed.add(chat)
        return changeBrowser((draft) => {
          const id = `brw_${crypto.randomUUID()}`
          adoptBrowserChat(draft, projectID, { id, chat, name, now: Date.now() })
        })
      },
      retireDeletedBrowserChat: (chat: string) => changeBrowser((draft) => retireDeletedBrowserChat(draft, chat)),
      forgetBrowserChat: (chat: string) => changeBrowser((draft) => void forgetBrowserChat(draft, chat)),
      renameBrowserSession: (projectID: string, id: string, name: string) =>
        changeBrowser((draft) => void renameBrowserSession(draft, projectID, id, name)),
      selectBrowserSession: (projectID: string, id: string) =>
        changeBrowser((draft) => selectBrowserSession(draft, projectID, id)),
      groupBrowserSession: (projectID: string, id: string, group?: string) =>
        changeBrowser((draft) => groupBrowserSession(draft, projectID, id, group)),
      creating,
      setCreating,
      open,
      start,
      // Folded category headers of the project tree, by "<project>:<group>"; kept between runs.
      groupCollapsed: (key: string) => panel.collapsed?.[key] === true,
      toggleGroup: (key: string) =>
        void updatePanel((draft) => {
          draft.collapsed ??= {}
          if (draft.collapsed[key]) delete draft.collapsed[key]
          else draft.collapsed[key] = true
        }).catch(() => undefined),
      project: () => panel.project,
      setProject: (projectID: string) =>
        void updatePanel((draft) => void (draft.project = projectID)).catch(() => undefined),
      chat: (sessionID: string) => chat[sessionID] === true,
      setChat: (sessionID: string, value: boolean) => setChat(sessionID, value),
      list,
      error: (directory: string) => listings[directory]?.error,
      loaded: (directory: string) => listings[directory] !== undefined,
      reload: load,
      bound,
      // The note a session shows as its document: bound, in Notes mode, and not put aside for the chat.
      canvas: (sessionID: string) => (tab() === "notes" && !chat[sessionID] ? bound(sessionID) : undefined),
      async create(directory: string, input: { title: string; body?: string; length?: NoteLength; session?: string }) {
        const result = await client.api.note.create({ location: { directory }, ...input })
        upsert(directory, result.data)
        return result.data
      },
      async save(directory: string, note: NoteInfo, body: string, expectedMtime: NoteInfo["mtime"] = note.mtime) {
        const result = await client.api.note.edit({ location: { directory }, name: note.name, body, expectedMtime })
        upsert(directory, result.data)
        return result.data
      },
      async get(directory: string, name: string) {
        const result = await client.api.note.get({ location: { directory }, name })
        upsert(directory, result.data)
        return result.data
      },
      update,
      link,
      async remove(directory: string, note: NoteInfo) {
        await client.api.note.remove({ location: { directory }, name: note.name, expectedMtime: Number(note.mtime) })
        setListings(directory, "notes", (notes) => notes.filter((item) => item.name !== note.name))
      },
    }
  },
})
