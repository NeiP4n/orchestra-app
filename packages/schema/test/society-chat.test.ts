import { describe, expect, test } from "bun:test"
import { Federation } from "../src/federation.js"
import { ProjectID } from "../src/orchestra.js"

const ids = ["prj_a", "prj_b", "prj_c"].map((id) => id as ProjectID)

describe("Society chat", () => {
  test("call signs are unique and do not depend on the group's order", () => {
    const signs = (list: ProjectID[]) => new Map(Federation.roster(list).map((item) => [item.project, item.callsign]))
    const forward = signs(ids)
    const backward = signs([...ids].reverse())
    expect(new Set(forward.values()).size).toBe(3)
    for (const id of ids) expect(backward.get(id)).toBe(forward.get(id))
    const many = Federation.roster(Array.from({ length: 30 }, (_, index) => `prj_${index}` as ProjectID))
    expect(new Set(many.map((item) => item.callsign)).size).toBe(30)
  })

  test("@name addresses one member, @all or no mention addresses everyone", () => {
    const members = Federation.roster(ids)
    const [first, second, third] = members.map((item) => item.callsign)
    expect(Federation.addressees(`@${second!.toLowerCase()}, check the API`, members).targets.map((item) => item.callsign)).toEqual([second])
    expect(Federation.addressees(`@${first} @${third!.toLowerCase()} go`, members).targets).toHaveLength(2)
    expect(Federation.addressees("@all status", members).targets).toHaveLength(3)
    expect(Federation.addressees("status please", members).direct).toBe(false)
    expect(Federation.addressees(`mail me@${first!.toLowerCase()}.io`, members).targets).toHaveLength(3)
    expect(Federation.addressees("@Zed hi", members).unknown).toEqual(["Zed"])
  })

  test("council results become one proposal per member", () => {
    const text = [
      '<group-council-results id="council_1" group="Shop">',
      "All invited project Orchestrators have returned proposals.",
      "Original subject: Add search",
      '<proposal project="Web" callsign="Atlas">\nUse &lt;form&gt;\n</proposal>',
      '<proposal project="API" callsign="Borei">\nAdd index\n</proposal>',
      "</group-council-results>",
    ].join("\n")
    const parsed = Federation.parseCouncilResults(text)
    expect(parsed?.group).toBe("Shop")
    expect(parsed?.subject).toBe("Add search")
    expect(parsed?.proposals.map((item) => [item.callsign, item.answer])).toEqual([
      ["Atlas", "Use <form>"],
      ["Borei", "Add index"],
    ])
    expect(Federation.parseCouncilResults("hello")).toBeUndefined()
  })

  test("reply options are lifted out of the prose", () => {
    const parsed = Federation.parseReplyOptions(
      "Which way?\n<reply-options>\n- Ship now | Ship it now\n- Wait\n</reply-options>",
    )
    expect(parsed.body).toBe("Which way?")
    expect(parsed.options).toEqual([
      { label: "Ship now", send: "Ship it now" },
      { label: "Wait", send: "Wait" },
    ])
    expect(Federation.parseReplyOptions("plain").options).toEqual([])
  })
})
