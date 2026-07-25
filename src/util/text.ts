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
