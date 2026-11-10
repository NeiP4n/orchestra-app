export * as SessionSkill from "./skill.js"

import type { Session } from "@orchestra/schema/session"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { ProcessSkills } from "../process-skills.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { Skill } from "../skill.js"
import { SkillNotFoundError } from "./error.js"

export const get = Effect.fn("SessionSkill.get")(function* (input: { session: Session.Info; skill: Skill.ID }) {
  const instances = yield* Instance.Service
  const skills = yield* Plugin.awaitActivation.pipe(Effect.andThen(Skill.Service), instances.provide(input.session))
  const agent = ProcessSkills.reserved(input.skill)
    ? (yield* Agent.Service.use((agents) => agents.select(input.session.agent)).pipe(instances.provide(input.session)))
        .id
    : (input.session.agent ?? "")
  const skill = yield* skills.get(input.skill, { sessionID: input.session.id, agent })
  if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
  return skill
})
