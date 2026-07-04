export interface PasteAssembler {
  active: boolean
  buffer: string
}

export interface PasteChunkResult {
  consumed: boolean
  complete?: string
}

const ESC = String.fromCharCode(27)
const PASTE_START = new RegExp(ESC + "?\\[200~")
const PASTE_END = new RegExp(ESC + "?\\[201~")

export const ENABLE_BRACKETED_PASTE = ESC + "[?2004h"
export const DISABLE_BRACKETED_PASTE = ESC + "[?2004l"

const COLLAPSE_MIN_LINES = 3
const COLLAPSE_MIN_CHARS = 400

const PILL_PATTERN = /\[Pasted #(\d+), \d+ lines?\]/g

export function createPasteAssembler(): PasteAssembler {
  return { active: false, buffer: "" }
}

export function feedPasteChunk(state: PasteAssembler, input: string): PasteChunkResult {
  let text = input
  if (!state.active) {
    const start = PASTE_START.exec(input)
    if (start === null) return { consumed: false }
    state.active = true
    state.buffer = ""
    text = input.slice(start.index + start[0].length)
  }

  const end = PASTE_END.exec(text)
  if (end === null) {
    state.buffer += text
    return { consumed: true }
  }

  state.buffer += text.slice(0, end.index)
  const complete = state.buffer
  state.active = false
  state.buffer = ""
  return { consumed: true, complete }
}

export function normalizePaste(raw: string): string {
  return raw.replace(/\r\n?/g, "\n")
}

export function shouldCollapsePaste(text: string): boolean {
  return countLines(text) >= COLLAPSE_MIN_LINES || text.length > COLLAPSE_MIN_CHARS
}

export function formatPastePill(id: number, text: string): string {
  const lines = countLines(text)
  return `[Pasted #${id}, ${lines} line${lines === 1 ? "" : "s"}]`
}

export function expandPastePills(value: string, store: Map<number, string>): string {
  return value.replace(PILL_PATTERN, (match, id) => store.get(Number(id)) ?? match)
}

function countLines(text: string): number {
  return text.split("\n").length
}
