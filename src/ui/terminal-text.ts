const ESCAPE = "\u001b"
const STRING_TERMINATOR = "\u009c"
const MAX_TITLE_LENGTH = 80

export function sanitizeTerminalText(value: string): string {
  let sanitized = ""

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    if (code === 0x1b) {
      index = skipEscapeSequence(value, index)
      continue
    }
    if (code === 0x9b) {
      index = skipControlSequence(value, index + 1)
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = skipControlString(value, index + 1, false)
      continue
    }
    if (code === 0x9d) {
      index = skipControlString(value, index + 1, true)
      continue
    }
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) {
      continue
    }

    sanitized += value[index]
  }

  return sanitized
}

export function sanitizeTerminalLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim()
}

export function sanitizeTerminalTitle(value: string, maxLength = MAX_TITLE_LENGTH): string {
  if (!Number.isInteger(maxLength) || maxLength < 0) {
    throw new RangeError("maxLength must be a non-negative integer")
  }
  const singleLine = sanitizeTerminalText(value).replace(/[\n\t]/g, "")
  return Array.from(singleLine).slice(0, maxLength).join("")
}

function skipEscapeSequence(value: string, escapeIndex: number): number {
  const next = value[escapeIndex + 1]
  if (next === undefined) return escapeIndex
  if (next === "[") return skipControlSequence(value, escapeIndex + 2)
  if (next === "]") return skipControlString(value, escapeIndex + 2, true)
  if (next === "P" || next === "X" || next === "^" || next === "_")
    return skipControlString(value, escapeIndex + 2, false)

  let index = escapeIndex + 1
  while (index < value.length && isEscapeIntermediate(value.charCodeAt(index))) index += 1
  return index
}

function skipControlSequence(value: string, startIndex: number): number {
  for (let index = startIndex; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index
  }
  return value.length - 1
}

function skipControlString(value: string, startIndex: number, allowBellTerminator: boolean): number {
  for (let index = startIndex; index < value.length; index += 1) {
    if (value[index] === STRING_TERMINATOR || (allowBellTerminator && value[index] === "\u0007")) return index
    if (value[index] === ESCAPE && value[index + 1] === "\\") return index + 1
  }
  return value.length - 1
}

function isEscapeIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f
}
