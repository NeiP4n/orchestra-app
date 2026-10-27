export interface KeyModifiers {
  readonly ctrl: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly meta: boolean
}

export type ModifierName = keyof KeyModifiers

export interface RawKeyEvent {
  readonly name?: string
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly alt?: boolean
  readonly meta?: boolean
  readonly sequence?: string
  readonly code?: string
  readonly type?: "keydown" | "keyup" | "keypress"
}

export type FocusEventType = "focus" | "blur" | "focus_in" | "focus_out" | "focusin" | "focusout"

export interface TerminalFocusEvent {
  readonly type: FocusEventType
}

export const FOCUS_IN_SEQUENCE = "\x1b[I"
export const FOCUS_OUT_SEQUENCE = "\x1b[O"
export const ESCAPE_SEQUENCE = "\x1b"

const EMPTY_MODIFIERS: KeyModifiers = {
  ctrl: false,
  shift: false,
  alt: false,
  meta: false,
}

export interface KeyboardModifierTrackerOptions {
  readonly onModifiersReset?: () => void
  readonly onModifierChange?: (modifiers: KeyModifiers) => void
  readonly stuckModifierTimeoutMs?: number
}

export class KeyboardModifierTracker {
  private modifiers: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } = {
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
  }

  private isTerminalFocused = true
  private lastActivityTimestamp = Date.now()
  private readonly stuckModifierTimeoutMs: number
  private readonly onModifiersReset?: () => void
  private readonly onModifierChange?: (modifiers: KeyModifiers) => void

  constructor(options: KeyboardModifierTrackerOptions = {}) {
    this.stuckModifierTimeoutMs = options.stuckModifierTimeoutMs ?? 30000
    this.onModifiersReset = options.onModifiersReset
    this.onModifierChange = options.onModifierChange
  }

  getModifiers(): KeyModifiers {
    this.checkStuckModifiers()
    return { ...this.modifiers }
  }

  isFocused(): boolean {
    return this.isTerminalFocused
  }

  hasActiveModifiers(): boolean {
    this.checkStuckModifiers()
    return (
      this.modifiers.ctrl ||
      this.modifiers.shift ||
      this.modifiers.alt ||
      this.modifiers.meta
    )
  }

  reset(): void {
    const wasActive = this.hasModifiersSet()
    this.modifiers = { ...EMPTY_MODIFIERS }
    this.lastActivityTimestamp = Date.now()
    if (wasActive) {
      this.onModifiersReset?.()
      this.onModifierChange?.({ ...EMPTY_MODIFIERS })
    }
  }

  handleFocusEvent(event: FocusEventType | TerminalFocusEvent): void {
    const type = typeof event === "string" ? event : event.type
    switch (type) {
      case "blur":
      case "focus_out":
      case "focusout":
        this.isTerminalFocused = false
        this.reset()
        break
      case "focus":
      case "focus_in":
      case "focusin":
        this.isTerminalFocused = true
        // Guarantee clean slate on window focus gain to avoid stuck modifiers from OS shortcuts
        this.reset()
        break
    }
  }

  processSequence(sequence: string): {
    readonly isFocusEvent: boolean
    readonly isEscape: boolean
    readonly handled: boolean
  } {
    if (sequence === FOCUS_OUT_SEQUENCE) {
      this.handleFocusEvent("focus_out")
      return { isFocusEvent: true, isEscape: false, handled: true }
    }

    if (sequence === FOCUS_IN_SEQUENCE) {
      this.handleFocusEvent("focus_in")
      return { isFocusEvent: true, isEscape: false, handled: true }
    }

    if (sequence === ESCAPE_SEQUENCE) {
      this.reset()
      return { isFocusEvent: false, isEscape: true, handled: true }
    }

    return { isFocusEvent: false, isEscape: false, handled: false }
  }

  processKeyEvent(event: RawKeyEvent): RawKeyEvent {
    this.lastActivityTimestamp = Date.now()

    // 1. If terminal is not focused, ignore or reset modifiers
    if (!this.isTerminalFocused) {
      this.reset()
    }

    // 2. Escape key or sequence resets all modifier states immediately
    const isEscape =
      event.name === "escape" ||
      event.name === "esc" ||
      event.sequence === ESCAPE_SEQUENCE ||
      event.code === "Escape"

    if (isEscape) {
      this.reset()
      return {
        ...event,
        ctrl: false,
        shift: false,
        alt: false,
        meta: false,
      }
    }

    // 3. Handle keyup events for specific modifier releases
    if (event.type === "keyup") {
      this.handleKeyup(event)
      return {
        ...event,
        ...this.modifiers,
      }
    }

    // 4. Synchronize modifier states with the current event
    // This immediately eliminates stuck modifiers if OS consumed release outside terminal
    const prevModifiers = { ...this.modifiers }

    this.modifiers = {
      ctrl: Boolean(event.ctrl),
      shift: Boolean(event.shift),
      alt: Boolean(event.alt),
      meta: Boolean(event.meta),
    }

    // Check if modifier state changed
    if (
      prevModifiers.ctrl !== this.modifiers.ctrl ||
      prevModifiers.shift !== this.modifiers.shift ||
      prevModifiers.alt !== this.modifiers.alt ||
      prevModifiers.meta !== this.modifiers.meta
    ) {
      this.onModifierChange?.(this.getModifiers())
    }

    return {
      ...event,
      ctrl: this.modifiers.ctrl,
      shift: this.modifiers.shift,
      alt: this.modifiers.alt,
      meta: this.modifiers.meta,
    }
  }

  private handleKeyup(event: RawKeyEvent): void {
    const keyName = event.name?.toLowerCase()
    let changed = false

    if (keyName === "control" || keyName === "ctrl") {
      this.modifiers.ctrl = false
      changed = true
    }
    if (keyName === "shift") {
      this.modifiers.shift = false
      changed = true
    }
    if (keyName === "alt" || keyName === "option") {
      this.modifiers.alt = false
      changed = true
    }
    if (keyName === "meta" || keyName === "command" || keyName === "cmd" || keyName === "super") {
      this.modifiers.meta = false
      changed = true
    }

    if (changed) {
      this.onModifierChange?.(this.getModifiers())
    }
  }

  private checkStuckModifiers(): void {
    if (this.stuckModifierTimeoutMs <= 0) return
    const elapsed = Date.now() - this.lastActivityTimestamp
    if (elapsed > this.stuckModifierTimeoutMs && this.hasModifiersSet()) {
      this.reset()
    }
  }

  private hasModifiersSet(): boolean {
    return (
      this.modifiers.ctrl ||
      this.modifiers.shift ||
      this.modifiers.alt ||
      this.modifiers.meta
    )
  }
}

export const defaultKeyboardTracker = new KeyboardModifierTracker()
