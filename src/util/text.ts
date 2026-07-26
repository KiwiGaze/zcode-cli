/**
 * The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, cut on a character boundary.
 * Slicing a string by length instead would count UTF-16 code units, which lets multi-byte text
 * overshoot a byte budget several times over; cutting the encoded buffer instead would risk
 * splitting a character and leaving a replacement char behind.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let bytes = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8")
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return text.slice(0, end)
}

/** Collapse anything that would break a one-line record into single spaces. */
export function toSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim()
}

const JSON_OBJECT = /\{[\s\S]*\}/

/**
 * The JSON object embedded in a model reply, tolerating code fences and prose around it. Null for
 * anything that is not a mapping — a bare array or scalar included — so callers validate fields
 * rather than shapes. Callers must treat null as their own fail-closed outcome.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const match = JSON_OBJECT.exec(raw)
  if (match === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/**
 * Clip `text` to `maxChars` by dropping its middle. Both ends are kept because what matters — a
 * credential, an error, a final answer — sits at one end far more often than in the middle. A
 * budget too small to hold the marker yields head and tail of nothing rather than the whole string.
 */
export function clipMiddle(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const fullMarker = `…[${text.length} chars]…`
  if (fullMarker.length >= maxChars) return fullMarker.slice(0, maxChars)

  const retained = maxChars - fullMarker.length
  const headLength = Math.ceil(retained / 2)
  const tailLength = Math.floor(retained / 2)
  const tail = tailLength === 0 ? "" : text.slice(-tailLength)
  const marker = `…[${text.length - headLength - tailLength} chars]…`
  return `${text.slice(0, headLength)}${marker}${tail}`
}
