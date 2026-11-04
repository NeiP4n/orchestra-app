import { Schema } from "effect"

export const MiniSkillDefinition = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  icon: Schema.String,
  instruction: Schema.String,
})

export type MiniSkillDefinition = typeof MiniSkillDefinition.Type

export const MiniSkillsSettings = Schema.Struct({
  items: Schema.Array(MiniSkillDefinition),
  placement: Schema.Literals(["above", "below"]),
  hidden: Schema.Boolean,
})

export type MiniSkillsSettings = typeof MiniSkillsSettings.Type

// Persisted key is a contract: renaming it would silently drop every user's mini skills and hidden state.
export const MiniSkillsPersistKey = "composer.mini-skills.v2"

export const INITIAL_MINI_SKILLS_SETTINGS = {
  items: [
    {
      id: "analyze",
      label: "Analyze",
      icon: "🔎",
      instruction:
        "Analyze the request and relevant context. Identify key facts, constraints, assumptions, and uncertainties. Do not modify files unless explicitly asked.",
    },
    {
      id: "plan",
      label: "Plan",
      icon: "🧭",
      instruction:
        "Create an ordered plan for the task. Identify dependencies, risks, affected areas, and verification steps. Do not change files yet.",
    },
    {
      id: "debug",
      label: "Debug",
      icon: "🐛",
      instruction:
        "Investigate the reported problem, trace it to the underlying cause, inspect relevant code and tests, and prefer the smallest safe fix. Avoid unrelated changes.",
    },
    {
      id: "review",
      label: "Review",
      icon: "🧐",
      instruction:
        "Review the relevant implementation for correctness, regressions, edge cases, security, and maintainability. Prioritize concrete findings and explain their impact.",
    },
    {
      id: "test",
      label: "Test",
      icon: "🧪",
      instruction:
        "Identify the behavior that needs verification, add or update the most appropriate tests, and run focused checks. Report the checks performed and their actual results.",
    },
    {
      id: "explain",
      label: "Explain",
      icon: "💡",
      instruction:
        "Explain the relevant code or concept in clear, simple language. Start with the key idea, then describe how it works and important trade-offs.",
    },
  ],
  placement: "above",
  hidden: false,
} satisfies MiniSkillsSettings
