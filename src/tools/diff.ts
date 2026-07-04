export interface DiffStat {
  additions: number
  deletions: number
}

export function lineDiffStat(oldText: string, newText: string): DiffStat {
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n")
  const newLines = newText.length === 0 ? [] : newText.split("\n")
  const oldCounts = countLines(oldLines)
  const newCounts = countLines(newLines)
  let additions = 0
  let deletions = 0
  const keys = new Set([...oldCounts.keys(), ...newCounts.keys()])
  for (const key of keys) {
    const delta = (newCounts.get(key) ?? 0) - (oldCounts.get(key) ?? 0)
    if (delta > 0) additions += delta
    else if (delta < 0) deletions += -delta
  }
  return { additions, deletions }
}

function countLines(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  return counts
}
