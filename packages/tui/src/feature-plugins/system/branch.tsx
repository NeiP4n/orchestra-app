import { Plugin } from "@orchestra/plugin/tui"
import { createResource } from "solid-js"
import { hasGithubDirectory } from "../../util/github"

// Switching branches is offered for projects that carry a `.github` folder, the mark of a GitHub project.
export default Plugin.define({
  id: "opencode.branch",
  setup(context) {
    const text = (en: string, ru: string) => (context.ui.language() === "ru" ? ru : en)

    const switchBranch = async () => {
      const location = context.location
      if (!location) return
      const current = context.data.location.vcs.info(location)?.branch.current
      const branches = await context.client.vcs.branch
        .list({ location: { directory: location.directory }, limit: 50 })
        .then((response) => response.data)
        .catch(() => undefined)
      if (!branches?.length) {
        context.ui.toast.show({
          title: text("No branches found", "Ветки не найдены"),
          message: text("This project has no branches to switch to.", "В этом проекте нет веток для переключения."),
          variant: "warning",
        })
        return
      }
      const branch = await context.ui.dialog.select({
        title: text("Switch branch", "Сменить ветку"),
        placeholder: text("Search branches", "Поиск веток"),
        current,
        options: branches.map((name) => ({ title: name, value: name })),
      })
      if (!branch || branch === current) return
      await context.client.vcs.branch
        .checkout({ location: { directory: location.directory }, branch })
        .then(() =>
          context.ui.toast.show({
            title: text("Branch switched", "Ветка изменена"),
            message: branch,
            variant: "success",
          }),
        )
        .catch((error: unknown) =>
          context.ui.toast.show({
            title: text("Could not switch branch", "Не удалось сменить ветку"),
            message: error instanceof Error ? error.message : String(error),
            variant: "error",
          }),
        )
    }

    context.ui.slot({
      append: "app",
      render() {
        const [github] = createResource(
          () => context.location?.directory,
          (directory) =>
            context.client.location
              .get({ location: { directory } })
              .then((info) => context.client.file.list({ location: { directory: info.project.directory } }))
              .then((response) => hasGithubDirectory(response.data))
              .catch(() => false),
        )
        context.keymap.layer(() => ({
          mode: "global",
          commands: github()
            ? [
                {
                  id: "opencode.branch.switch",
                  title: text("Switch branch", "Сменить ветку"),
                  group: "Git",
                  slash: { name: "branch" },
                  palette: true,
                  run: () => void switchBranch(),
                },
              ]
            : [],
        }))
        return null
      },
    })
  },
})
