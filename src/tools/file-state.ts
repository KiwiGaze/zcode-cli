export class FileState {
  private readAt = new Map<string, number>()

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
}
