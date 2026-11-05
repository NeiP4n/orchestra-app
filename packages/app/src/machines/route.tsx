import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { addMachine, removeMachine, startMachine, stopMachine } from "./controller"
import { isFullVm, type Machine, type MachineBackend, type MachineStatus } from "./machine"
import { loadMachines, removeMachineRecord, saveMachine, type MachineStorage } from "./persistence"

// Desktop-only autonomous AI workspace panel. The TUI has no equivalent
// panel: this route exists only in the desktop/web shell. Phase E layout:
// machines rail on the left, agent and terminal in the centre, files and
// tasks on the right. Colours come from the active theme tokens, so the
// panel follows the sculk theme when sculk is selected, instead of
// hardcoding sculk hex values in the component.
export function MachinesRoute() {
  const language = useLanguage()
  const platform = usePlatform()
  const [machines, setMachines] = createStore<Machine[]>([])
  const [name, setName] = createSignal("")
  const [terminalCommand, setTerminalCommand] = createSignal("")
  const [terminalOutput, setTerminalOutput] = createSignal("")
  const [filesPath, setFilesPath] = createSignal("/")
  const [filesOutput, setFilesOutput] = createSignal("")
  const [tasksOutput, setTasksOutput] = createSignal("")
  const [logsOutput, setLogsOutput] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)

  // User actions used to swallow IPC failures silently, leaving the panel
  // showing a stale status with no hint anything failed. Surface the error
  // text in the panel instead; background persistence saves stay silent.
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- promise rejection reasons are inherently unknown; this function parses them into a message.
  const reportError = (thrown: unknown) => {
    setError(thrown instanceof Error ? thrown.message : String(thrown))
  }
  // WSL is the priority backend for the Windows desktop target; firecracker
  // cannot start from IPC yet and qemu-kvm has no driver at all, so neither
  // may be the default a fresh machine is created with.

  const [backend, setBackend] = createSignal<MachineBackend>("wsl")
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)
  const selected = createMemo(() => machines.find((machine) => machine.id === selectedId()))

  // Desktop storage is a namespace storage with enumeration; web storage
  // is a plain sync storage without it, so persistence is only used
  // where the namespace storage is actually present.
  // SAFETY: the checks below confirm the enumeration methods exist
  // before the storage is used as a MachineStorage.
  const machineStorage = (): MachineStorage | undefined => {
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- see SAFETY above
    const storage = platform.storage?.("machines") as Partial<MachineStorage> | undefined
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- see SAFETY above
    const hasEnumeration = storage && typeof storage.getLength === "function" && typeof storage.key === "function"

    if (!hasEnumeration) return undefined

    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- see SAFETY above
    return storage as MachineStorage
  }

  onMount(() => {
    const storage = machineStorage()

    if (!storage) return

    void loadMachines(storage)
      .then((loaded) => {
        if (loaded.length === 0) return

        // Repair machines stuck in "creating" by the old create path, which
        // never transitioned them onward: creation is synchronous, so they
        // are stopped and startable.
        const repaired = loaded.map((machine) => (machine.status === "creating" ? { ...machine, status: "stopped" as const } : machine))

        setMachines(repaired)
        setSelectedId(repaired[0].id)

        for (const machine of repaired) {
          if (machine.status === "stopped" && loaded.find((old) => old.id === machine.id)?.status === "creating") {
            void saveMachine(storage, machine).catch(() => undefined)
          }
        }
      })
      .catch(reportError)
  })

  const statusLabel = (status: MachineStatus) => {
    switch (status) {
      case "creating":
        return language.t("machines.status.creating")
      case "stopped":
        return language.t("machines.status.stopped")
      case "starting":
        return language.t("machines.status.starting")
      case "running":
        return language.t("machines.status.running")
      case "stopping":
        return language.t("machines.status.stopping")
      case "error":
        return language.t("machines.status.error")
      case "destroying":
        return language.t("machines.status.destroying")
    }
  }

  const create = () => {
    if (!name().trim()) return

    const id = `machine_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const createdAt = Date.now()
    const spec = { name: name(), backend: backend(), cpu: 2, memoryMb: 2048, diskGb: 20, network: false }

    setMachines((list) => addMachine(list, spec, id, createdAt))

    const storage = machineStorage()

    if (storage) {
      void saveMachine(storage, { ...spec, id, status: "stopped", createdAt }).catch(() => undefined)
    }

    setSelectedId(id)
    setName("")
  }

  const applyUpdated = (updated: Machine) => {
    setMachines((list) => list.map((machine) => (machine.id === updated.id ? updated : machine)))

    const storage = machineStorage()

    if (storage) void saveMachine(storage, updated).catch(() => undefined)
  }

  const start = (id: string) => {
    if (!platform.machines) {
      const next = startMachine(machines, id)
      const updated = next.find((machine) => machine.id === id)

      setMachines(next)

      const storage = machineStorage()

      if (storage && updated) void saveMachine(storage, updated).catch(() => undefined)

      return
    }

    void platform.machines
      .start(id)
      .then(applyUpdated)
      .catch(reportError)
  }

  const stop = (id: string) => {
    if (!platform.machines) {
      const next = stopMachine(machines, id)
      const updated = next.find((machine) => machine.id === id)

      setMachines(next)

      const storage = machineStorage()

      if (storage && updated) void saveMachine(storage, updated).catch(() => undefined)

      return
    }

    void platform.machines
      .stop(id)
      .then(applyUpdated)
      .catch(reportError)
  }

  const snapshot = (id: string) => {
    if (!platform.machines) return

    void platform.machines
      .snapshot(id)
      .then(applyUpdated)
      .catch(reportError)
  }

  const toggleNetwork = (id: string, network: boolean) => {
    if (!platform.machines) {
      const updated = machines.find((machine) => machine.id === id)

      if (!updated) return

      const next = { ...updated, network }

      setMachines((list) => list.map((machine) => (machine.id === id ? next : machine)))

      const storage = machineStorage()

      if (storage) void saveMachine(storage, next).catch(() => undefined)

      return
    }

    void platform.machines
      .network(id, network)
      .then(applyUpdated)
      .catch(reportError)
  }

  const reset = async (id: string) => {
    if (!platform.machines) {
      const stopped = stopMachine(machines, id)
      const restarted = startMachine(stopped, id)
      const updated = restarted.find((machine) => machine.id === id)

      setMachines(restarted)

      const storage = machineStorage()

      if (storage && updated) await saveMachine(storage, updated).catch(() => undefined)

      return
    }

    try {
      applyUpdated(await platform.machines.stop(id))
      applyUpdated(await platform.machines.start(id))
    } catch (thrown) {
      // A failed reset leaves the machine in its last known state;
      // the user can retry Start or Stop from the same header.
      reportError(thrown)
    }
  }

  const runTerminal = (id: string) => {
    if (!platform.machines) return

    const command = terminalCommand().trim().split(/\s+/).filter(Boolean)

    if (command.length === 0) return

    void platform.machines
      .exec(id, command)
      .then((result) => setTerminalOutput(`${result.stdout}\n${language.t("machines.exitCode")}: ${result.exitCode}`))
      .catch(reportError)
  }

  const listFiles = (id: string) => {
    if (!platform.machines) return

    const path = filesPath().trim() || "/"

    void platform.machines
      .exec(id, ["ls", "-la", path])
      .then((result) => setFilesOutput(`${result.stdout}\n${language.t("machines.exitCode")}: ${result.exitCode}`))
      .catch(reportError)
  }

  const refreshTasks = (id: string) => {
    if (!platform.machines) return

    void platform.machines
      .exec(id, ["ps", "aux"])
      .then((result) => setTasksOutput(`${result.stdout}\n${language.t("machines.exitCode")}: ${result.exitCode}`))
      .catch(reportError)
  }

  const refreshLogs = (id: string) => {
    if (!platform.machines) return

    void platform.machines
      .logs(id)
      .then((result) => setLogsOutput(`${result.stdout}\n${language.t("machines.exitCode")}: ${result.exitCode}`))
      .catch(reportError)
  }

  const remove = (id: string) => {
    // On desktop, delete through IPC so the backend is stopped and removed
    // too; deleting only the local record used to orphan live containers,
    // distros and VMs with no cleanup path.
    if (platform.machines?.delete) {
      void platform.machines
        .delete(id)
        .then(() => {
          setMachines((list) => removeMachine(list, id))
          setSelectedId(undefined)
        })
        .catch(reportError)

      return
    }

    setMachines((list) => removeMachine(list, id))

    const storage = machineStorage()

    if (storage) void removeMachineRecord(storage, id).catch(() => undefined)

    setSelectedId(undefined)
  }

  return (
    <div data-slot="machines-panel" class="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4">
      <Show when={error()} keyed>
        {(message) => (
          <p class="text-v2-text-text-danger">
            {language.t("machines.error")}: {message}
          </p>
        )}
      </Show>
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-v2-text-text-base text-lg font-semibold">{language.t("machines.title")}</h1>
        <input
          aria-label={language.t("machines.name")}
          placeholder={language.t("machines.name")}
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
          class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-v2-text-text-base"
        />
        <select
          aria-label={language.t("machines.backend")}
          value={backend()}
          onChange={(event) => {
            const value = event.currentTarget.value

            // qemu-kvm is deliberately not offered: it has no driver at all,
            // so offering it only creates machines that can never start.
            if (value === "firecracker" || value === "apple-vz" || value === "wsl" || value === "container") {
              setBackend(value)
            }
          }}
          class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-v2-text-text-base"
        >
          <option value="firecracker">firecracker</option>
          <option value="apple-vz">apple-vz</option>
          <option value="wsl">wsl</option>
          <option value="container">container</option>
        </select>
        <button
          type="button"
          onClick={create}
          class="rounded-md bg-v2-background-bg-accent px-3 py-1 text-v2-text-text-accent"
        >
          {language.t("machines.create")}
        </button>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)_240px] gap-4 max-lg:grid-cols-1">
        <section aria-label={language.t("machines.title")} class="min-h-0 overflow-auto rounded-md border border-v2-border-border-base p-2">
          <Show when={machines.length === 0} fallback={null}>
            <p class="text-v2-text-text-muted">{language.t("machines.empty")}</p>
          </Show>
          <ul class="flex flex-col gap-2">
            <For each={machines}>
              {(machine) => (
                <li>
                  <button
                    type="button"
                    onClick={() => setSelectedId(machine.id)}
                    class="w-full rounded-md px-2 py-2 text-left hover:bg-v2-background-bg-subtle"
                  >
                    <span class="block font-medium text-v2-text-text-base">{machine.name}</span>
                    <span class="block text-v2-text-text-muted">{machine.backend} · {statusLabel(machine.status)}</span>
                    <Show when={!isFullVm(machine.backend)}>
                      <span class="block text-v2-text-text-muted">{language.t("machines.containerNote")}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
        <section class="flex min-h-0 flex-col gap-4">
          <Show
            when={selected()}
            fallback={<p class="text-v2-text-text-muted">{language.t("machines.noSelection")}</p>}
            keyed
          >
            {(machine) => (
              <>
                <div class="flex flex-wrap items-center gap-2">
                  <h2 class="text-v2-text-text-base font-semibold">{machine.name}</h2>
                  <span class="text-v2-text-text-muted">{statusLabel(machine.status)}</span>
                  <Show when={machine.status === "stopped" || machine.status === "error"}>
                    <button type="button" onClick={() => start(machine.id)}>
                      {language.t("machines.start")}
                    </button>
                  </Show>
                  <Show when={machine.status === "running" || machine.status === "starting"}>
                    <button type="button" onClick={() => stop(machine.id)}>
                      {language.t("machines.stop")}
                    </button>
                  </Show>
                  <Show when={machine.status === "running"}>
                    <button type="button" onClick={() => void reset(machine.id)}>
                      {language.t("machines.reset")}
                    </button>
                  </Show>
                  <Show when={machine.status === "running"}>
                    <button type="button" onClick={() => toggleNetwork(machine.id, !machine.network)}>
                      {machine.network ? language.t("machines.networkOff") : language.t("machines.networkOn")}
                    </button>
                  </Show>
                  <Show when={platform.machines}>
                    <button type="button" onClick={() => snapshot(machine.id)}>
                      {language.t("machines.snapshot")}
                    </button>
                  </Show>
                  <button type="button" onClick={() => remove(machine.id)}>
                    {language.t("machines.delete")}
                  </button>
                </div>
                <div class="min-h-0 flex-1 rounded-md border border-v2-border-border-base p-3">
                  <h3 class="text-v2-text-text-base font-medium">{language.t("machines.agent")}</h3>
                  <p class="text-v2-text-text-muted">{language.t("machines.agentEmpty")}</p>
                </div>
                <div class="min-h-0 flex-1 rounded-md border border-v2-border-border-base p-3">
                  <h3 class="text-v2-text-text-base font-medium">{language.t("machines.terminal")}</h3>
                  <Show
                    when={platform.machines && machine.status === "running"}
                    fallback={<p class="text-v2-text-text-muted">{language.t("machines.terminalEmpty")}</p>}
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <input
                        aria-label={language.t("machines.command")}
                        placeholder={language.t("machines.command")}
                        value={terminalCommand()}
                        onInput={(event) => setTerminalCommand(event.currentTarget.value)}
                      />
                      <button type="button" onClick={() => runTerminal(machine.id)}>
                        {language.t("machines.run")}
                      </button>
                    </div>
                    <pre class="mt-2 whitespace-pre-wrap text-v2-text-text-base">{terminalOutput()}</pre>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </section>
        <section class="flex min-h-0 flex-col gap-4">
          <div class="rounded-md border border-v2-border-border-base p-3">
            <h3 class="text-v2-text-text-base font-medium">{language.t("machines.files")}</h3>
            <Show
              when={platform.machines && selected()?.status === "running"}
              fallback={<p class="text-v2-text-text-muted">{language.t("machines.filesEmpty")}</p>}
            >
              <div class="flex flex-wrap items-center gap-2">
                <input
                  aria-label={language.t("machines.path")}
                  placeholder={language.t("machines.path")}
                  value={filesPath()}
                  onInput={(event) => setFilesPath(event.currentTarget.value)}
                />
                <button
                  type="button"
                  onClick={() => {
                    const machine = selected()

                    if (machine) listFiles(machine.id)
                  }}
                >
                  {language.t("machines.list")}
                </button>
              </div>
              <pre class="mt-2 whitespace-pre-wrap text-v2-text-text-base">{filesOutput()}</pre>
            </Show>
          </div>
          <div class="rounded-md border border-v2-border-border-base p-3">
            <h3 class="text-v2-text-text-base font-medium">{language.t("machines.tasks")}</h3>
            <Show
              when={platform.machines && selected()?.status === "running"}
              fallback={<p class="text-v2-text-text-muted">{language.t("machines.tasksEmpty")}</p>}
            >
              <button
                type="button"
                onClick={() => {
                  const machine = selected()

                  if (machine) refreshTasks(machine.id)
                }}
              >
                {language.t("machines.refresh")}
              </button>
              <pre class="mt-2 whitespace-pre-wrap text-v2-text-text-base">{tasksOutput()}</pre>
            </Show>
          </div>
          <div class="rounded-md border border-v2-border-border-base p-3">
            <h3 class="text-v2-text-text-base font-medium">{language.t("machines.logs")}</h3>
            <Show
              when={platform.machines && selected()?.status === "running"}
              fallback={<p class="text-v2-text-text-muted">{language.t("machines.logsEmpty")}</p>}
            >
              <button
                type="button"
                onClick={() => {
                  const machine = selected()

                  if (machine) refreshLogs(machine.id)
                }}
              >
                {language.t("machines.refresh")}
              </button>
              <pre class="mt-2 whitespace-pre-wrap text-v2-text-text-base">{logsOutput()}</pre>
            </Show>
          </div>
        </section>
      </div>
      <footer class="flex flex-wrap items-center gap-3 border-t border-v2-border-border-base pt-2 text-v2-text-text-muted">
        <Show
          when={selected()}
          fallback={<span>{language.t("machines.noSelection")}</span>}
        >
          {(machine) => (
            <>
              <span class="text-v2-text-text-base font-medium">{machine().name}</span>
              <span>{statusLabel(machine().status)}</span>
              <span>{machine().backend}</span>
              <span>
                {machine().cpu} CPU · {machine().memoryMb} MB · {machine().diskGb} GB
              </span>
              <span>{isFullVm(machine().backend) ? language.t("machines.fullVmNote") : language.t("machines.containerNote")}</span>
            </>
          )}
        </Show>
        <span class="ml-auto">
          {machines.length} {language.t("machines.title")}
        </span>
      </footer>
    </div>
  )
}
