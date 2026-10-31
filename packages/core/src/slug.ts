export * as Slug from "./slug.js"

import { checksum } from "@orchestra/util/encode"

// Society folders are created by whichever machine wins the race, and a Russian project name is
// normal input. Every folder is therefore a plain ASCII slug that Windows, macOS and Linux all
// accept; transliterating instead of hashing keeps the folder readable in a file manager.
const cyrillic: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
  ў: "u",
}

// Windows keeps these names for devices in every directory, with or without an extension, so a
// project called "con" or "com1" would otherwise be unreadable or uncreatable there.
const reserved = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

const defaultMax = 48

// A filesystem-safe folder name: ASCII only, at most `max` characters, and never a Windows device
// name. A value with nothing usable left falls back to `fallback` (sluggified as well) or to a
// stable `item-<hash>` of the value itself, so two different names never share one folder.
export function folder(value: string, options?: { max?: number; fallback?: string }) {
  const max = options?.max ?? defaultMax
  const slug = tidy(transliterate(value).slice(0, max))
  if (slug) return protect(slug)

  const fallback = tidy(transliterate(options?.fallback ?? "").slice(0, max))
  if (fallback) return protect(fallback)

  return `item-${checksum(value) ?? "0"}`
}

// NFKD splits accented Latin letters into a base letter and a mark, so dropping the marks folds
// "café" into "cafe" before the Cyrillic letters are transliterated.
function transliterate(value: string) {
  return [...value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()]
    .map((character) => cyrillic[character] ?? character)
    .join("")
}

// Runs of anything outside the allowed set become one dash, and a name never starts or ends with a
// dash or a dot: Windows silently drops trailing dots and spaces, and a leading dot hides the
// folder on Unix.
function tidy(value: string) {
  return value
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "")
}

function protect(slug: string) {
  return reserved.has(slug.split(".")[0]) ? `_${slug}` : slug
}
