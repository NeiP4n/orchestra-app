import { createMemo, createResource } from "solid-js"
import { useClient } from "../context/client"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { useT } from "../util/i18n"

// The rulebook of one scope (global, project:<id> or society:<name>): the standing rules its AIs follow and
// may add to. The operator adds, reads and deletes them here; a rule an AI wrote shows who wrote it.
export function DialogRules(props: { scope: string; title: string }) {
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const t = useT()
  const [rules] = createResource(() => client.api.orchestra.rules.list({ scope: props.scope }).catch(() => []))

  const reopen = () => dialog.replace(() => <DialogRules scope={props.scope} title={props.title} />)
  const fail = (error: unknown) => toast.show({ message: errorMessage(error), variant: "error" })

  const add = () =>
    dialog.replace(() => (
      <DialogPrompt
        title={t("New rule")}
        placeholder={t("One short sentence every AI of this crew must follow")}
        onCancel={reopen}
        onConfirm={(text) => {
          const value = text.trim()
          if (!value) return reopen()
          void client.api.orchestra.rules.add({ scope: props.scope, text: value }).then(reopen).catch((error: unknown) => {
            fail(error)
            reopen()
          })
        }}
      />
    ))

  const remove = (rule: { id: string; text: string }) =>
    dialog.replace(() => (
      <DialogConfirm
        title={t("Delete rule")}
        message={rule.text}
        onCancel={reopen}
        onConfirm={() => {
          void client.api.orchestra.rules.remove({ scope: props.scope, id: rule.id }).then(reopen).catch((error: unknown) => {
            fail(error)
            reopen()
          })
        }}
      />
    ))

  const options = createMemo(() => [
    { title: `+ ${t("Add a rule")}`, value: "add", description: t("The AIs of this crew follow it from their next request") },
    ...(rules.latest ?? []).map((rule) => ({
      title: rule.text,
      value: rule.id,
      footer: rule.by,
    })),
  ])

  return (
    <DialogSelect
      title={`${t("Rules")} · ${props.title}`}
      options={options()}
      onSelect={(option) => {
        if (option.value === "add") return add()
        const rule = (rules.latest ?? []).find((item) => item.id === option.value)
        if (rule) remove(rule)
      }}
      footerHints={[{ title: t("delete"), label: "enter" }]}
    />
  )
}
