export interface PasteAssembler {
  active: boolean
  buffer: string
  pending: string
}

export type PasteChunkPart = { kind: "text"; value: string } | { kind: "paste"; value: string }

export interface PasteChunkResult {
  consumed: boolean
  parts: PasteChunkPart[]
}

export interface PastePillRange {
  start: number
  end: number
  id: number
}

const ESC = String.fromCharCode(27)
const PASTE_START_MARKERS = [`${ESC}[200~`, "[200~"] as const
const PASTE_END_MARKERS = [`${ESC}[201~`, "[201~"] as const

export const ENABLE_BRACKETED_PASTE = ESC + "[?2004h"
export const DISABLE_BRACKETED_PASTE = ESC + "[?2004l"

const COLLAPSE_MIN_LINES = 3
const COLLAPSE_MIN_CHARS = 400

const PILL_PATTERN = /\[Pasted #(\d+), \d+ lines?\]/g
const PILL_AT_END = /\[Pasted #(\d+), \d+ lines?\]$/
const PILL_AT_START = /^\[Pasted #(\d+), \d+ lines?\]/

export function createPasteAssembler(): PasteAssembler {
  return { active: false, buffer: "", pending: "" }
}

export function feedPasteChunk(state: PasteAssembler, input: string): PasteChunkResult {
  let text = state.pending + input
  let consumed = state.active || state.pending.length > 0
  state.pending = ""
  const parts: PasteChunkPart[] = []

  while (true) {
    const markers = state.active ? PASTE_END_MARKERS : PASTE_START_MARKERS
    const marker = findMarker(text, markers)
    if (marker === null) {
      const split = splitMarkerPrefix(text, markers)
      state.pending = split.pending
      if (state.active) {
        state.buffer += split.complete
        return { consumed: true, parts }
      }

      if (!consumed && split.pending.length === 0) return { consumed: false, parts: [] }
      consumed = true
      if (split.complete.length > 0) parts.push({ kind: "text", value: split.complete })
      return { consumed, parts }
    }

    if (!state.active) {
      consumed = true
      if (marker.index > 0) parts.push({ kind: "text", value: text.slice(0, marker.index) })
      state.active = true
      state.buffer = ""
      text = text.slice(marker.index + marker.value.length)
      continue
    }

    state.buffer += text.slice(0, marker.index)
    parts.push({ kind: "paste", value: state.buffer })
    state.active = false
    state.buffer = ""
    text = text.slice(marker.index + marker.value.length)
    if (text.length === 0) return { consumed: true, parts }
  }
}

export function takePendingPasteText(state: PasteAssembler): string {
  if (state.active) return ""
  const pending = state.pending
  state.pending = ""
  return pending
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

export function pillEndingAt(value: string, cursor: number): PastePillRange | null {
  const match = PILL_AT_END.exec(value.slice(0, cursor))
  if (match === null) return null
  return { start: cursor - match[0].length, end: cursor, id: Number(match[1]) }
}

export function pastePillStartingAt(value: string, cursor: number): PastePillRange | null {
  const match = PILL_AT_START.exec(value.slice(cursor))
  if (match === null) return null
  return { start: cursor, end: cursor + match[0].length, id: Number(match[1]) }
}

function countLines(text: string): number {
  return text.split("\n").length
}

function findMarker(text: string, markers: readonly string[]): { index: number; value: string } | null {
  let found: { index: number; value: string } | null = null
  for (const marker of markers) {
    const index = text.indexOf(marker)
    if (index < 0 || (found !== null && found.index <= index)) continue
    found = { index, value: marker }
  }
  return found
}

function splitMarkerPrefix(text: string, markers: readonly string[]): { complete: string; pending: string } {
  const maxLength = Math.min(text.length, Math.max(...markers.map((marker) => marker.length - 1)))
  for (let length = maxLength; length > 0; length -= 1) {
    const suffix = text.slice(-length)
    if (markers.some((marker) => marker.startsWith(suffix))) {
      return { complete: text.slice(0, -length), pending: suffix }
    }
  }
  return { complete: text, pending: "" }
}
