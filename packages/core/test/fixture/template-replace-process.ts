import { ProjectTemplateV2Library as Library } from "../../src/project-template-v2-library"
import { ProjectTemplateV2 as Codec } from "../../src/project-template-v2"
import { Flock } from "@orchestra/util/flock"
import path from "node:path"

const root = process.argv[2]
Flock.setGlobal({ state: path.join(root, "state") })
const library = Library.local(root)
const variants = await Promise.all(["first", "second"].map(async (id) => {
  const value = Codec.preview(await Bun.file(path.join(root, id + ".json")).text())
  if (!value.ok) throw Error(value.error)
  return value.value
}))
let prior = await library.preview("factory")
for (let index = 0; ; index++) {
  const next = variants[index % variants.length]
  await library.replaceSerialized(next.text, "factory", prior.digest, next.digest)
  prior = next
  if (index === 0) console.log("UPDATE_COMMITTED")
}
