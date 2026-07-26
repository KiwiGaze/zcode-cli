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

export function resolveTerminalSequenceAction(
  sequence: string,
  { owner = "input", focusReporting }: KeyResolutionOptions,
): KeyAction | undefined {
  if (focusReporting && (sequence === "[I" || sequence === "\u001b[I")) return "terminal.focus"
  if (focusReporting && (sequence === "[O" || sequence === "\u001b[O")) return "terminal.blur"

  const arrow = terminalArrow(sequence)
  if (owner === "picker") {
    if (sequence === "\u001b") return "picker.cancel"
    if (sequence === "\r") return "picker.accept"
    if (arrow === "up") return "picker.previous"
    if (arrow === "down") return "picker.next"
    return undefined
  }

  if (sequence.startsWith("\u001b\u001b") && arrow === "up") return "queue.restore"
  if (sequence === "\u001b") return "input.abort"
  if (sequence === "\u001b\r") return "input.newline"
  if (sequence === "\r") return "input.submit"
  if (arrow === "up") return "input.history.previous"
  if (arrow === "down") return "input.history.next"
  if (arrow === "left") return "input.cursor.left"
  if (arrow === "right") return "input.cursor.right"
  if (sequence === "\b" || sequence === "\u007f") return "input.backspace"
  if (/^\u001b\[3(?:(?:;\d+)*~|[$^])$/.test(sequence) || sequence === "\u001b\u007f") {
    return "input.delete"
  }
  return undefined
}

function terminalArrow(sequence: string): "up" | "down" | "left" | "right" | undefined {
  const match = /^(?:\u001b){0,2}(?:\[(?:[\d;?]*|\[)|O)([ABCDabcd])$/.exec(sequence)
  if (match?.[1]?.toUpperCase() === "A") return "up"
  if (match?.[1]?.toUpperCase() === "B") return "down"
  if (match?.[1]?.toUpperCase() === "C") return "right"
  if (match?.[1]?.toUpperCase() === "D") return "left"
  return undefined
}
