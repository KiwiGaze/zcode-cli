export class FileState {
  private readAt = new Map<string, number>()
  private touched = new Set<string>()

  markRead(absPath: string, mtimeMs: number): void {
    this.readAt.set(absPath, mtimeMs)
  }

  wasRead(absPath: string): boolean {
    return this.readAt.has(absPath)
  }

  /** True when the file changed on disk after we last read it. */
  isStale(absPath: string, currentMtimeMs: number): boolean {
    const seen = this.readAt.get(absPath)
    if (seen === undefined) return false
    return currentMtimeMs > seen
  }

  /** Record that a file was read, written, or edited this session (drives conditional skills). */
  markTouched(absPath: string): void {
    this.touched.add(absPath)
  }

  touchedPaths(): string[] {
    return [...this.touched]
  }
}
