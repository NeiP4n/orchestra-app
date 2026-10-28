import { expect, test } from "bun:test"
import { createPaneResize } from "../src/ui/pane-resize"

test("keyboard step and reset controls allow smooth left/right panel resizing with clamping", () => {
  let value = 30
  const commits: number[] = []

  const resize = createPaneResize({
    value: () => value,
    defaultValue: () => 30,
    clamp: (size) => Math.max(16, Math.min(60, size)),
    fromMouse: (event) => event.x,
    contains: (event, size) => event.x >= size - 1 && event.x <= size,
    onCommit: (size) => {
      commits.push(size)
      value = size
    },
  })

  expect(resize.size()).toBe(30)

  // Step wider (expand right panel by 4)
  resize.step(4)
  expect(resize.size()).toBe(34)
  expect(commits).toEqual([34])

  // Step narrower (shrink right panel by 4)
  resize.step(-4)
  expect(resize.size()).toBe(30)
  expect(commits).toEqual([34, 30])

  // Step beyond max clamp (60)
  resize.step(100)
  expect(resize.size()).toBe(60)

  // Step beyond min clamp (16)
  resize.step(-100)
  expect(resize.size()).toBe(16)

  // Reset restores default width (30)
  resize.reset()
  expect(resize.size()).toBe(30)
})
