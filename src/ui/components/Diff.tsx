import React from "react"
import { Box, Text } from "ink"
import { diffLines, diffWords, type Change } from "diff"
import { sanitizeTerminalText } from "@/ui/terminal-text"
import { useTheme } from "@/ui/theme"

interface DiffProps {
  oldText: string
  newText: string
}

const MAX_DIFF_PREVIEW_CHARS = 2_048
const MAX_DIFF_PREVIEW_LINES = 100

export function Diff({ oldText, newText }: DiffProps): React.ReactElement {
  const theme = useTheme()
  if (!fitsPreviewBudget(oldText) || !fitsPreviewBudget(newText)) {
    return <Text color={theme.text.muted}>diff preview omitted · replacement exceeds display budget</Text>
  }

  const changes = diffLines(sanitizeTerminalText(oldText), sanitizeTerminalText(newText), { oneChangePerToken: true })
  const rows: React.ReactElement[] = []

  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index]
    if (change === undefined) continue
    const next = changes[index + 1]
    const previous = changes[index - 1]
    const following = changes[index + 2]
    const isSingleLineReplacement =
      change.removed && next?.added && previous?.removed !== true && following?.added !== true
    if (isSingleLineReplacement) {
      const wordChanges = diffWords(withoutTrailingNewline(change.value), withoutTrailingNewline(next.value))
      rows.push(
        <WordDiffRow key={`${index}-removed`} prefix="-" changes={wordChanges} changed="removed" />,
        <WordDiffRow key={`${index}-added`} prefix="+" changes={wordChanges} changed="added" />,
      )
      index += 1
      continue
    }

    const prefix = change.added ? "+" : change.removed ? "-" : " "
    const color = change.added ? theme.diff.added : change.removed ? theme.diff.removed : theme.diff.context
    rows.push(
      <Text key={index} color={color} wrap="truncate-end">
        {prefix} {withoutTrailingNewline(change.value)}
      </Text>,
    )
  }

  return <Box flexDirection="column">{rows}</Box>
}

function WordDiffRow({
  prefix,
  changes,
  changed,
}: {
  prefix: string
  changes: Change[]
  changed: "added" | "removed"
}): React.ReactElement {
  const theme = useTheme()
  const lineColor = changed === "added" ? theme.diff.added : theme.diff.removed
  const wordColor = changed === "added" ? theme.diff.addedWord : theme.diff.removedWord
  return (
    <Text color={lineColor} wrap="truncate-end">
      {prefix}{" "}
      {changes.map((part, index) => {
        const isChanged = changed === "added" ? part.added : part.removed
        if ((changed === "added" && part.removed) || (changed === "removed" && part.added)) return null
        return (
          <Text key={index} color={isChanged ? wordColor : lineColor} bold={theme.colorsEnabled && isChanged}>
            {part.value}
          </Text>
        )
      })}
    </Text>
  )
}

function withoutTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value
}

function fitsPreviewBudget(text: string): boolean {
  return text.length <= MAX_DIFF_PREVIEW_CHARS && text.split("\n").length <= MAX_DIFF_PREVIEW_LINES
}
