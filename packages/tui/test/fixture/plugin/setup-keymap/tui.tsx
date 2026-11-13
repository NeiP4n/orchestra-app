import { appendFileSync } from "node:fs"
import { Plugin } from "@orchestra/plugin/tui"
import { batch, createSignal } from "solid-js"

const generation = "generation 1"

// A test-owned receipt proves calls while the modal intentionally hides app toasts.
function announce(context: Plugin.Context, message: string) {
  appendFileSync(new URL("./events.jsonl", import.meta.url), JSON.stringify(message) + "\n")
  context.ui.toast.show({ message })
}

export default Plugin.define({
  id: "fixture.setup-keymap",
  async setup(context) {
    const [runs, setRuns] = createSignal(0)
    let syncs = 0
    context.keymap.layer(() => ({
      commands: [
        {
          id: "fixture.sync",
          title: "Sync setup check",
          bind: "f9",
          run: () => announce(context, `Sync keymap ran ${++syncs}`),
        },
      ],
    }))
    await Promise.resolve()
    if (context.options.fail) {
      setTimeout(
        () =>
          context.keymap.layer(() => ({
            commands: [
              {
                id: "fixture.late",
                title: "Late setup check",
                bind: "f10",
                run: () => announce(context, "Late keymap ran"),
              },
            ],
          })),
        20,
      )
      batch(() => context.keymap.layer(() => ({ commands: [{ title: "Invalid", palette: true, run: () => {} }] })))
    }
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fixture.setup",
          title: `Setup check ${runs()}`,
          palette: true,
          slash: { name: "setup-check" },
          bind: "ctrl+g",
          run() {
            setRuns((count) => count + 1)
            announce(context, `Setup keymap ran ${runs()}`)
          },
        },
        {
          id: "fixture.dialog",
          title: "Open fixture dialog",
          bind: "f8",
          run: () => context.ui.dialog.show(() => <FixtureDialog context={context} />),
        },
      ],
    }))
    announce(context, `Fixture ready ${generation}`)
  },
})

function FixtureDialog(props: { context: Plugin.Context }) {
  let presses = 0
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [{ bind: "f11", run: () => announce(props.context, `Dialog keymap ran ${++presses}`) }],
  }))
  return <text>Fixture dialog</text>
}
