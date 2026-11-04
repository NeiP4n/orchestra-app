import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { useThemes } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { createSignal, onCleanup } from "solid-js"

export function DialogThemeList() {
  const themes = useThemes()
  const toast = useToast()
  const options = Object.keys(themes.all())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((value) => ({
      title: value,
      value: value,
    }))
  const dialog = useDialog()
  const [saving, setSaving] = createSignal(false)
  let confirmed = false
  let ref: DialogSelectRef<string>
  const initial = themes.selected

  // Navigation only previews: the visible theme changes, nothing is written.
  // Cancel restores the original theme in memory — no config write at all.
  onCleanup(() => {
    if (!confirmed) themes.preview(initial)
  })

  return (
    <DialogSelect
      title="Themes"
      options={options}
      current={initial}
      loading={saving()}
      onMove={(opt) => {
        themes.preview(opt.value)
      }}
      onSelect={(opt) => {
        if (saving()) return
        setSaving(true)
        themes
          .commit(opt.value)
          .then(() => {
            confirmed = true
            dialog.clear()
          })
          .catch((error) => {
            toast.error(error instanceof Error ? error : new Error(String(error)))
          })
          .finally(() => setSaving(false))
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          themes.preview(initial)
          return
        }

        const first = ref.filtered[0]
        if (first) themes.preview(first.value)
      }}
    />
  )
}
