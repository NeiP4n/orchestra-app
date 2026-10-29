import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Spinner } from "./spinner"

type Progress = { label: string; numerator?: number; denominator?: number }

// The migration itself reported an error, as opposed to a failed attempt to ask how it is going.
class MigrationFailed extends Error {}

export function MigrationOverlay() {
  const client = useClient()
  const toast = useToast()
  const theme = useTheme()
  const [progress, setProgress] = createSignal<Progress>()
  const abort = new AbortController()

  onMount(async () => {
    await Bun.sleep(1_000)
    // A status poll can fail for reasons that have nothing to do with the migration: the server was just
    // restarted or replaced, and the connection resets once. Only a run of failures, or the migration's
    // own error, is worth a message.
    const MAX_POLL_FAILURES = 5
    void (async () => {
      let failures = 0
      while (true) {
        const status = await client.api.migration.v1.status({ signal: abort.signal }).then(
          (value) => {
            failures = 0
            return value
          },
          (error: unknown) => {
            if (abort.signal.aborted || ++failures >= MAX_POLL_FAILURES) throw error
            return undefined
          },
        )
        if (status) {
          setProgress(status.status === "running" ? status.progress : undefined)
          if (status.status === "completed") return
          if (status.status === "error") throw new MigrationFailed(status.error)
        }
        await Bun.sleep(1_000)
      }
    })().catch((error) => {
      if (abort.signal.aborted) return
      setProgress(undefined)
      toast.show({
        variant: "error",
        title: error instanceof MigrationFailed ? "Data migration failed" : "Could not read the data migration status",
        message: errorMessage(error),
        duration: 10_000,
      })
    })
  })
  onCleanup(() => abort.abort())

  const count = (value: Progress) => {
    if (value.numerator === undefined) return ""
    if (value.denominator === undefined) return ` ${value.numerator}`
    return ` ${value.numerator}/${value.denominator}`
  }

  return (
    <Show when={progress()}>
      {(value) => (
        <box
          position="absolute"
          zIndex={10_000}
          top={1}
          right={2}
          flexDirection="row"
          backgroundColor={theme.background.raised.high}
          border={["left"]}
          borderColor={theme.text.feedback.info.base}
          customBorderChars={SplitBorder.customBorderChars}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <Spinner color={theme.text.feedback.info.base}>
            {value().label}
            {count(value())}
          </Spinner>
        </box>
      )}
    </Show>
  )
}
