export * as Tag from "./tag.js"

// Reports from another computer or another session reach a model wrapped in a tag that says
// whose words they are. Text inside must not close that tag or its attributes, or it could go
// on in the operator's voice.

// A value placed in a tag attribute.
export function attribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

// A body that must not end the tag around it early, in any letter case.
export function unclosable(text: string, tag: string) {
  return text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1")
}
