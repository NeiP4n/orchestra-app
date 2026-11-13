/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { PromptRefProvider } from "../src/context/prompt"
import { ProjectsProvider } from "../src/context/projects"
import { SocietyRoster } from "../src/routes/session/society"
import { agent, renderLocal, session } from "./fixture/local"
import { setActiveLanguage } from "../src/util/i18n"
import { directory, json } from "./fixture/tui-client"

const chat = { ...session("ses_society", undefined, "orchestrator"), metadata: { "orchestra:group-supervisor": { groupName: "Games", leader: "prj_a", mode: "council" } } }
const projects = ["prj_a", "prj_b", "prj_c"].map((id, index) => ({
  id,
  name: ["Planner", "Architects", "Coders"][index],
  directory,
  main: `ses_main_${id}`,
}))

// The roster is JSX the compiler cannot check for stray text: a comment typed among its children is drawn as text
// outside any <text> and crashes the whole interface. Rendering it with members is the only thing that catches that.
for (const language of ["en", "ru"] as const) test(`the Society roster uses its own ${language} locale and renders one row`, async () => {
  // Non-component strings can use the last app language; mounted components
  // must instead follow their own ConfigProvider even when it differs.
  setActiveLanguage(language === "en" ? "ru" : "en")
  try {
  await using setup = await renderLocal({
    language,
    agents: [agent("orchestrator")],
    sessions: [chat as never],
    fetch: (url) => {
      if (url.pathname === "/api/orchestra/group")
        return json([{ name: "Games", projects: projects.map((project) => project.id), mode: "council", supervisor: "ses_society" }])
      if (url.pathname === "/api/orchestra/project") return json(projects)
      if (url.pathname === "/api/orchestra/hold") return json([])
      if (/^\/api\/orchestra\/group\/[^/]+\/status$/.test(url.pathname))
        return json({ held: false, projects: projects.map((project) => ({ id: project.id, name: project.name, done: 1, total: 2, blocked: 0, running: false })) })
      return undefined
    },
    view: () => (
      <PromptRefProvider>
        <ProjectsProvider>
          <SocietyRoster sessionID="ses_society" />
        </ProjectsProvider>
      </PromptRefProvider>
    ),
  })
  await setup.data.session.sync("ses_society").catch(() => undefined)
  const frame = await setup.waitForFrame((current) => current.includes("DoD 3/6"), { maxPasses: 100 })
  const row = frame.split("\n").find((line) => line.includes("DoD")) ?? ""
  // Every member's call sign is on that one row, and nothing from a comment leaked onto the screen.
  expect(row.match(/[●○◉?]\w+/g)?.length).toBe(3)
  expect(frame).not.toContain("One row, no wrapping")
  expect(frame).toContain(language === "ru" ? "правил" : "rules")
  if (process.env.CAPTURE_SOCIETY) await Bun.write(`${process.env.CAPTURE_SOCIETY}-${language}.json`, JSON.stringify(setup.captureSpans()))
  } finally {
    setActiveLanguage("en")
  }
})
