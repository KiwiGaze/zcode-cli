import type { Key } from "ink"

export type KeyboardOwner = "input" | "picker"

export interface KeyResolutionOptions {
  owner?: KeyboardOwner
  focusReporting: boolean
  rawInput?: string
}

export type KeyAction =
  | "input.submit"
  | "input.newline"
  | "input.abort"
  | "input.history.previous"
  | "input.history.next"
  | "input.cursor.left"
  | "input.cursor.right"
  | "input.backspace"
  | "input.delete"
  | "queue.restore"
  | "picker.accept"
  | "picker.cancel"
  | "picker.previous"
  | "picker.next"
  | "terminal.focus"
  | "terminal.blur"

export function resolveKeyAction(
  input: string,
  key: Key,
  { owner = "input", focusReporting, rawInput = input }: KeyResolutionOptions,
): KeyAction | undefined {
  if (focusReporting && (input === "[I" || input === "\u001b[I")) return "terminal.focus"
  if (focusReporting && (input === "[O" || input === "\u001b[O")) return "terminal.blur"

  if (owner === "picker") {
    if (key.escape) return "picker.cancel"
    if (key.return) return "picker.accept"
    if (key.upArrow) return "picker.previous"
    if (key.downArrow) return "picker.next"
    return undefined
  }

  if (key.meta && key.upArrow) return "queue.restore"
  if (key.escape) return "input.abort"
  if (key.meta && key.return) return "input.newline"
  if (key.return) return "input.submit"
  if (key.upArrow) return "input.history.previous"
  if (key.downArrow) return "input.history.next"
  if (key.leftArrow) return "input.cursor.left"
  if (key.rightArrow) return "input.cursor.right"
  if (key.backspace || (key.delete && rawInput === "\u007f")) {
    return "input.backspace"
  }
  if (key.delete) return "input.delete"
  return undefined
}
