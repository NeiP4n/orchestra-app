import { describe, expect, test } from "bun:test"
import {
  ESCAPE_SEQUENCE,
  FOCUS_IN_SEQUENCE,
  FOCUS_OUT_SEQUENCE,
  KeyboardModifierTracker,
} from "../src/keyboard"

describe("Keyboard Modifier Tracker & Focus Handling (OPT-019)", () => {
  test("tracks active modifier keys on keydown", () => {
    const tracker = new KeyboardModifierTracker()

    const eventWithCtrl = tracker.processKeyEvent({
      name: "c",
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    })

    expect(eventWithCtrl.ctrl).toBeTrue()
    expect(tracker.getModifiers()).toEqual({
      ctrl: true,
      shift: false,
      alt: false,
      meta: false,
    })
    expect(tracker.hasActiveModifiers()).toBeTrue()
  })

  test("resets all modifiers on blur and focus_out events", () => {
    let resetCount = 0
    const tracker = new KeyboardModifierTracker({
      onModifiersReset: () => {
        resetCount++
      },
    })

    // 1. Set active modifiers
    tracker.processKeyEvent({
      name: "x",
      ctrl: true,
      alt: true,
    })
    expect(tracker.hasActiveModifiers()).toBeTrue()

    // 2. Trigger blur event
    tracker.handleFocusEvent("blur")
    expect(tracker.hasActiveModifiers()).toBeFalse()
    expect(tracker.getModifiers()).toEqual({
      ctrl: false,
      shift: false,
      alt: false,
      meta: false,
    })
    expect(tracker.isFocused()).toBeFalse()
    expect(resetCount).toBe(1)

    // 3. Set modifiers again and trigger focus_out string
    tracker.handleFocusEvent("focus_in")
    tracker.processKeyEvent({
      name: "z",
      meta: true,
      shift: true,
    })
    expect(tracker.hasActiveModifiers()).toBeTrue()

    tracker.handleFocusEvent({ type: "focus_out" })
    expect(tracker.hasActiveModifiers()).toBeFalse()
    expect(resetCount).toBe(2)
  })

  test("resets modifiers on terminal escape sequence and ESC key", () => {
    const tracker = new KeyboardModifierTracker()

    // 1. Active modifiers
    tracker.processKeyEvent({
      name: "k",
      ctrl: true,
      shift: true,
    })
    expect(tracker.hasActiveModifiers()).toBeTrue()

    // 2. Escape key resets all
    const escEvent = tracker.processKeyEvent({
      name: "escape",
      ctrl: true,
      shift: true,
    })

    expect(escEvent.ctrl).toBeFalse()
    expect(escEvent.shift).toBeFalse()
    expect(tracker.hasActiveModifiers()).toBeFalse()

    // 3. Raw ESC sequence (\x1b) resets modifiers
    tracker.processKeyEvent({
      name: "f",
      alt: true,
    })
    expect(tracker.hasActiveModifiers()).toBeTrue()

    const result = tracker.processSequence(ESCAPE_SEQUENCE)
    expect(result.isEscape).toBeTrue()
    expect(result.handled).toBeTrue()
    expect(tracker.hasActiveModifiers()).toBeFalse()
  })

  test("resets modifiers on terminal focus out sequence (\\x1b[O)", () => {
    const tracker = new KeyboardModifierTracker()

    tracker.processKeyEvent({
      name: "a",
      ctrl: true,
      alt: true,
    })
    expect(tracker.hasActiveModifiers()).toBeTrue()

    const res = tracker.processSequence(FOCUS_OUT_SEQUENCE)
    expect(res.isFocusEvent).toBeTrue()
    expect(res.handled).toBeTrue()
    expect(tracker.isFocused()).toBeFalse()
    expect(tracker.hasActiveModifiers()).toBeFalse()
  })

  test("prevents stuck modifiers when switching between terminal and GUI apps", () => {
    const tracker = new KeyboardModifierTracker()

    // User presses Alt+Tab or Ctrl+C in terminal
    tracker.processKeyEvent({
      name: "tab",
      alt: true,
    })
    expect(tracker.getModifiers().alt).toBeTrue()

    // OS switches focus to browser/editor (focus out escape sequence received)
    tracker.processSequence(FOCUS_OUT_SEQUENCE)
    expect(tracker.getModifiers().alt).toBeFalse()

    // User releases Alt in GUI app, then clicks back into terminal (focus in sequence)
    tracker.processSequence(FOCUS_IN_SEQUENCE)
    expect(tracker.isFocused()).toBeTrue()
    expect(tracker.hasActiveModifiers()).toBeFalse()

    // User presses normal key 'p' without modifiers
    const nextEvent = tracker.processKeyEvent({
      name: "p",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    })

    // Modifier must NOT be stuck
    expect(nextEvent.alt).toBeFalse()
    expect(tracker.getModifiers().alt).toBeFalse()
  })

  test("handles keyup events for individual modifier releases", () => {
    const tracker = new KeyboardModifierTracker()

    tracker.processKeyEvent({
      name: "shift",
      shift: true,
      ctrl: true,
    })
    expect(tracker.getModifiers().shift).toBeTrue()
    expect(tracker.getModifiers().ctrl).toBeTrue()

    // Keyup for shift only
    tracker.processKeyEvent({
      type: "keyup",
      name: "shift",
    })

    expect(tracker.getModifiers().shift).toBeFalse()
    expect(tracker.getModifiers().ctrl).toBeTrue()

    // Keyup for ctrl
    tracker.processKeyEvent({
      type: "keyup",
      name: "control",
    })

    expect(tracker.getModifiers().ctrl).toBeFalse()
    expect(tracker.hasActiveModifiers()).toBeFalse()
  })

  test("auto-resets stuck modifiers after inactivity timeout", async () => {
    const tracker = new KeyboardModifierTracker({
      stuckModifierTimeoutMs: 30,
    })

    tracker.processKeyEvent({
      name: "ctrl",
      ctrl: true,
    })
    expect(tracker.hasActiveModifiers()).toBeTrue()

    // Wait past the timeout
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(tracker.hasActiveModifiers()).toBeFalse()
    expect(tracker.getModifiers().ctrl).toBeFalse()
  })
})
