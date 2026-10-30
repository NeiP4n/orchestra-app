import { expect, test } from "bun:test"
import {
  moveSelection,
  moveSelectionOffset,
  reconcileSelection,
  reconcileSelectionWindow,
  revealSelectionOffset,
} from "../../src/ui/select-controller"

test("reconciles and moves selections with explicit boundary policy", () => {
  expect([reconcileSelection(3, 0), reconcileSelection(4, 3), reconcileSelection(2, 6)]).toEqual([0, 2, 2])
  expect([
    moveSelection(0, { count: 3, delta: -1, policy: "clamp" }),
    moveSelection(2, { count: 3, delta: 1, policy: "clamp" }),
    moveSelection(0, { count: 3, delta: -1, policy: "wrap" }),
    moveSelection(2, { count: 3, delta: 1, policy: "wrap" }),
  ]).toEqual([0, 2, 2, 0])
})

test("reveals selections within bounded windows", () => {
  expect([
    revealSelectionOffset(5, { count: 20, limit: 8, selected: 3 }),
    revealSelectionOffset(3, { count: 20, limit: 8, selected: 11 }),
    revealSelectionOffset(3, { count: 20, limit: 8, selected: 10 }),
    revealSelectionOffset(20, { count: 20, limit: 8, selected: 19 }),
  ]).toEqual([3, 4, 3, 12])
})

test("keeps the selection inside a manually scrolled window", () => {
  expect([
    reconcileSelectionWindow(5, { count: 40, limit: 10, offset: 17 }),
    reconcileSelectionWindow(25, { count: 40, limit: 10, offset: 10 }),
    reconcileSelectionWindow(12, { count: 40, limit: 10, offset: 10 }),
  ]).toEqual([17, 19, 12])
})

test("keeps movement offsets and preview margins in bounds", () => {
  expect([
    moveSelectionOffset(0, { count: 20, limit: 8, selected: 6, direction: 1 }),
    moveSelectionOffset(8, { count: 20, limit: 8, selected: 9, direction: -1 }),
    moveSelectionOffset(12, { count: 20, limit: 8, selected: 19, direction: 1 }),
    moveSelectionOffset(4, { count: 4, limit: 8, selected: 3, direction: 1 }),
  ]).toEqual([1, 7, 12, 0])
})

test("adversarial: handles empty collections and non-positive counts safely", () => {
  // reconcileSelection with count <= 0 always clamps to 0
  expect(reconcileSelection(0, 0)).toBe(0)
  expect(reconcileSelection(5, 0)).toBe(0)
  expect(reconcileSelection(-3, 0)).toBe(0)
  expect(reconcileSelection(10, -5)).toBe(0)

  // moveSelection with count <= 0 returns 0 immediately
  expect(moveSelection(0, { count: 0, delta: 1, policy: "clamp" })).toBe(0)
  expect(moveSelection(0, { count: 0, delta: -1, policy: "wrap" })).toBe(0)
  expect(moveSelection(5, { count: -1, delta: 10, policy: "wrap" })).toBe(0)

  // reconcileSelectionWindow with count <= 0 returns 0
  expect(reconcileSelectionWindow(0, { count: 0, limit: 10, offset: 0 })).toBe(0)
  expect(reconcileSelectionWindow(5, { count: -3, limit: 5, offset: 2 })).toBe(0)

  // revealSelectionOffset with count <= 0
  expect(revealSelectionOffset(0, { count: 0, limit: 10, selected: 0 })).toBe(0)
})

test("adversarial: handles single item collections without out-of-bounds oscillation", () => {
  expect(reconcileSelection(0, 1)).toBe(0)
  expect(reconcileSelection(5, 1)).toBe(0)
  expect(reconcileSelection(-2, 1)).toBe(0)

  // Moving within single-item collection stays at index 0 regardless of policy
  expect(moveSelection(0, { count: 1, delta: 1, policy: "clamp" })).toBe(0)
  expect(moveSelection(0, { count: 1, delta: -1, policy: "clamp" })).toBe(0)
  expect(moveSelection(0, { count: 1, delta: 1, policy: "wrap" })).toBe(0)
  expect(moveSelection(0, { count: 1, delta: -1, policy: "wrap" })).toBe(0)
})

test("adversarial: handles extreme deltas and out-of-bounds offsets", () => {
  // Extreme positive and negative deltas with clamp
  expect(moveSelection(2, { count: 10, delta: 1_000_000, policy: "clamp" })).toBe(9)
  expect(moveSelection(2, { count: 10, delta: -1_000_000, policy: "clamp" })).toBe(0)

  // Extreme deltas with wrap: negative wraps to last, positive wraps to first
  expect(moveSelection(2, { count: 10, delta: -1_000_000, policy: "wrap" })).toBe(9)
  expect(moveSelection(2, { count: 10, delta: 1_000_000, policy: "wrap" })).toBe(0)

  // Offsets and limits where limit exceeds count
  expect(reconcileSelectionWindow(15, { count: 5, limit: 50, offset: 0 })).toBe(4)
  expect(reconcileSelectionWindow(-5, { count: 5, limit: 50, offset: 0 })).toBe(0)
  expect(revealSelectionOffset(0, { count: 5, limit: 50, selected: 4 })).toBe(0)
  expect(moveSelectionOffset(0, { count: 5, limit: 50, selected: 4, direction: 1 })).toBe(0)
})