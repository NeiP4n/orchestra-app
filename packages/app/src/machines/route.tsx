import { For, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { addMachine, removeMachine, startMachine, stopMachine } from "./controller"
import { isFullVm, type Machine, type MachineBackend, type MachineStatus } from "./machine"

// Desktop-only autonomous AI workspace panel. The TUI has no equivalent
// panel: this route exists only in the desktop/web shell. Phase E layout:
// machines rail on the left, agent and terminal in the centre, files and
// tasks on the right. Colours come from the active theme tokens, so the
// panel follows the sculk theme when sculk is selected, instead of
// hardcoding sculk hex values in the component.
export function MachinesRoute() {
  const language = useLanguage()
  const [machines, setMachines] = createStore<Machine[]>([])
  const [name, setName] = createSignal("")
  const [backend, setBackend] = createSignal<MachineBackend>("firecracker")
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)
  const selected = createMemo(() => machines.find((machine) => machine.id === selectedId()))

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

    const id = `machine_${Date.now()}`

    setMachines((list) =>
      addMachine(list, { name: name(), backend: backend(), cpu: 2, memoryMb: 2048, diskGb: 20, network: false }, id, Date.now()),
    )
    setSelectedId(id)
    setName("")
  }

  return (
    <div data-slot="machines-panel" class="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4">
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

            if (value === "firecracker" || value === "qemu-kvm" || value === "apple-vz" || value === "wsl" || value === "container") {
              setBackend(value)
            }
          }}
          class="rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-2 py-1 text-v2-text-text-base"
        >
          <option value="firecracker">firecracker</option>
          <option value="qemu-kvm">qemu-kvm</option>
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
                    <button type="button" onClick={() => setMachines((list) => startMachine(list, machine.id))}>
                      {language.t("machines.start")}
                    </button>
                  </Show>
                  <Show when={machine.status === "running" || machine.status === "starting"}>
                    <button type="button" onClick={() => setMachines((list) => stopMachine(list, machine.id))}>
                      {language.t("machines.stop")}
                    </button>
                  </Show>
                  <button
                    type="button"
                    onClick={() => {
                      setMachines((list) => removeMachine(list, machine.id))
                      setSelectedId(undefined)
                    }}
                  >
                    {language.t("machines.delete")}
                  </button>
                </div>
                <div class="min-h-0 flex-1 rounded-md border border-v2-border-border-base p-3">
                  <h3 class="text-v2-text-text-base font-medium">{language.t("machines.agent")}</h3>
                  <p class="text-v2-text-text-muted">{language.t("machines.agentEmpty")}</p>
                </div>
                <div class="min-h-0 flex-1 rounded-md border border-v2-border-border-base p-3">
                  <h3 class="text-v2-text-text-base font-medium">{language.t("machines.terminal")}</h3>
                  <p class="text-v2-text-text-muted">{language.t("machines.terminalEmpty")}</p>
                </div>
              </>
            )}
          </Show>
        </section>
        <section class="flex min-h-0 flex-col gap-4">
          <div class="rounded-md border border-v2-border-border-base p-3">
            <h3 class="text-v2-text-text-base font-medium">{language.t("machines.files")}</h3>
            <p class="text-v2-text-text-muted">{language.t("machines.filesEmpty")}</p>
          </div>
          <div class="rounded-md border border-v2-border-border-base p-3">
            <h3 class="text-v2-text-text-base font-medium">{language.t("machines.tasks")}</h3>
            <p class="text-v2-text-text-muted">{language.t("machines.tasksEmpty")}</p>
          </div>
        </section>
      </div>
    </div>
  )
}
