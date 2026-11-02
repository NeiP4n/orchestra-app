import { For, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { addMachine, removeMachine, startMachine, stopMachine } from "./controller"
import { isFullVm, type Machine, type MachineBackend, type MachineStatus } from "./machine"

// Desktop-only autonomous AI workspace panel. The TUI has no equivalent
// panel: this route exists only in the desktop/web shell, and its layout
// (machines rail on the left, agent/terminal in the centre, files/tasks on
// the right) is the Phase E sculk shell, not a TUI screen.
export function MachinesRoute() {
  const language = useLanguage()
  const [machines, setMachines] = createStore<Machine[]>([])
  const [name, setName] = createSignal("")
  const [backend, setBackend] = createSignal<MachineBackend>("firecracker")

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

    setMachines((list) =>
      addMachine(list, { name: name(), backend: backend(), cpu: 2, memoryMb: 2048, diskGb: 20, network: false }, `machine_${Date.now()}`, Date.now()),
    )
    setName("")
  }

  return (
    <div data-slot="machines-panel" class="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4">
      <h1 class="text-v2-text-text-base text-lg font-semibold">{language.t("machines.title")}</h1>
      <div class="flex flex-wrap items-center gap-2">
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
      <Show when={machines.length === 0} fallback={null}>
        <p class="text-v2-text-text-muted">{language.t("machines.empty")}</p>
      </Show>
      <ul class="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        <For each={machines}>
          {(machine) => (
            <li class="flex flex-wrap items-center gap-3 rounded-md border border-v2-border-border-base px-3 py-2">
              <span class="font-medium text-v2-text-text-base">{machine.name}</span>
              <span class="text-v2-text-text-muted">{machine.backend}</span>
              <Show when={!isFullVm(machine.backend)}>
                <span class="text-v2-text-text-muted">{language.t("machines.containerNote")}</span>
              </Show>
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
              <button type="button" onClick={() => setMachines((list) => removeMachine(list, machine.id))}>
                {language.t("machines.delete")}
              </button>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
