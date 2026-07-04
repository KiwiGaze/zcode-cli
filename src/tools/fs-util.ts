import path from "node:path"

export function resolvePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
}

export function relativePath(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath)
  return rel.length === 0 ? path.basename(absPath) : rel
}

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".exe", ".dll", ".so", ".class", ".jar", ".war", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".bin", ".dat", ".obj", ".o", ".a", ".lib", ".wasm", ".pyc", ".pyo",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp3", ".mp4", ".mov",
])

export function looksBinaryByExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export function looksBinaryBySample(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}
