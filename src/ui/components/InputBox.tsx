import React from "react"
import { Box, Text, useInput, useStdout } from "ink"
import { useTheme } from "@/ui/theme"
import { matchCommands, type SlashCommand } from "@/commands/registry"
import { resolveKeyAction, type KeyAction } from "@/ui/keybindings"
import { sanitizeTerminalText } from "@/ui/terminal-text"
import {
  createPasteAssembler,
  feedPasteChunk,
  normalizePaste,
  shouldCollapsePaste,
  formatPastePill,
  expandPastePills,
  takePendingPasteText,
  pillEndingAt,
  pastePillStartingAt,
  ENABLE_BRACKETED_PASTE,
  DISABLE_BRACKETED_PASTE,
} from "@/ui/paste"

export interface InputBoxProps {
  onSubmit: (value: string) => void
  onAbort: () => readonly string[]
  onRestoreQueue: () => readonly string[]
  onFocusChange: (focused: boolean) => void
  focusReporting: boolean
  busy: boolean
  isActive: boolean
  skills?: SlashCommand[]
}

interface EditorBuffer {
  value: string
  cursor: number
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export function InputBox({
  onSubmit,
  onAbort,
  onRestoreQueue,
  onFocusChange,
  focusReporting,
  busy,
  isActive,
  skills = [],
}: InputBoxProps): React.ReactElement {
  const theme = useTheme()
  const [buf, setBuf] = React.useState<EditorBuffer>({ value: "", cursor: 0 })
  const bufRef = React.useRef(buf)
  const { value, cursor } = buf
  const historyRef = React.useRef<string[]>([])
  const historyIndexRef = React.useRef<number | null>(null)
  const historyDraftRef = React.useRef("")
  const pasteRef = React.useRef(createPasteAssembler())
  const pasteStoreRef = React.useRef<Map<number, string>>(new Map())
  const pasteIdRef = React.useRef(1)
  const { stdout, write } = useStdout()

  const replaceBuffer = (next: EditorBuffer) => {
    bufRef.current = next
    setBuf(next)
  }

  const updateBuffer = (update: (current: EditorBuffer) => EditorBuffer) => {
    const next = update(bufRef.current)
    replaceBuffer(next)
  }

  React.useEffect(() => {
    if (!stdout.isTTY) return
    write(ENABLE_BRACKETED_PASTE)
    const disable = () => write(DISABLE_BRACKETED_PASTE)
    process.on("exit", disable)
    return () => {
      disable()
      process.removeListener("exit", disable)
    }
  }, [stdout.isTTY, write])

  const insertAtCursor = (text: string) =>
    updateBuffer((b) => ({
      value: b.value.slice(0, b.cursor) + text + b.value.slice(b.cursor),
      cursor: b.cursor + text.length,
    }))

  const prependDrafts = (drafts: readonly string[]) => {
    if (drafts.length === 0) return
    historyIndexRef.current = null
    historyDraftRef.current = ""
    updateBuffer((current) => {
      const restored = drafts.map(sanitizeTerminalText).join("\n\n")
      const value = current.value.length === 0 ? restored : `${restored}\n\n${current.value}`
      return { value, cursor: value.length }
    })
  }

  const handleAction = (action: KeyAction): void => {
    if (action === "terminal.focus") {
      onFocusChange(true)
      return
    }
    if (action === "terminal.blur") {
      onFocusChange(false)
      return
    }
    if (action === "input.abort") {
      if (busy) prependDrafts(onAbort())
      else if (bufRef.current.value.length > 0) {
        historyIndexRef.current = null
        historyDraftRef.current = ""
        replaceBuffer({ value: "", cursor: 0 })
      }
      return
    }
    if (action === "input.newline") {
      insertAtCursor("\n")
      return
    }
    if (action === "input.submit") {
      const current = bufRef.current.value
      const submitted = expandPastePills(current, pasteStoreRef.current)
      if (submitted.trim().length === 0) return
      historyRef.current = [...historyRef.current, current]
      historyIndexRef.current = null
      historyDraftRef.current = ""
      replaceBuffer({ value: "", cursor: 0 })
      onSubmit(submitted)
      return
    }
    if (action === "queue.restore") {
      prependDrafts(onRestoreQueue())
      return
    }
    if (action === "input.history.previous") {
      const history = historyRef.current
      if (history.length === 0) return
      const historyIndex = historyIndexRef.current
      if (historyIndex === null) historyDraftRef.current = bufRef.current.value
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
      historyIndexRef.current = next
      const recalled = history[next] ?? ""
      replaceBuffer({ value: recalled, cursor: recalled.length })
      return
    }
    if (action === "input.history.next") {
      const historyIndex = historyIndexRef.current
      const history = historyRef.current
      if (historyIndex === null) return
      const next = historyIndex + 1
      if (next >= history.length) {
        historyIndexRef.current = null
        const draft = historyDraftRef.current
        replaceBuffer({ value: draft, cursor: draft.length })
      } else {
        historyIndexRef.current = next
        const recalled = history[next] ?? ""
        replaceBuffer({ value: recalled, cursor: recalled.length })
      }
      return
    }
    if (action === "input.cursor.left") {
      updateBuffer((current) => {
        const pill = pillEndingAt(current.value, current.cursor)
        return {
          ...current,
          cursor: pill?.start ?? previousGraphemeBoundary(current.value, current.cursor),
        }
      })
      return
    }
    if (action === "input.cursor.right") {
      updateBuffer((current) => {
        const pill = pastePillStartingAt(current.value, current.cursor)
        return {
          ...current,
          cursor: pill?.end ?? nextGraphemeBoundary(current.value, current.cursor),
        }
      })
      return
    }
    if (action === "input.backspace") {
      updateBuffer((current) => {
        if (current.cursor === 0) return current
        const pill = pillEndingAt(current.value, current.cursor)
        if (pill !== null) {
          return {
            value: current.value.slice(0, pill.start) + current.value.slice(current.cursor),
            cursor: pill.start,
          }
        }
        const start = previousGraphemeBoundary(current.value, current.cursor)
        return {
          value: current.value.slice(0, start) + current.value.slice(current.cursor),
          cursor: start,
        }
      })
      return
    }
    if (action === "input.delete") {
      updateBuffer((current) => {
        if (current.cursor === current.value.length) return current
        const pill = pastePillStartingAt(current.value, current.cursor)
        const end = pill?.end ?? nextGraphemeBoundary(current.value, current.cursor)
        return {
          value: current.value.slice(0, current.cursor) + current.value.slice(end),
          cursor: current.cursor,
        }
      })
    }
  }

  useInput(
    (input, key) => {
      const action = resolveKeyAction(input, key, { focusReporting })
      if (!pasteRef.current.active && action !== undefined) {
        const pendingText = sanitizeTerminalText(takePendingPasteText(pasteRef.current))
        if (pendingText.length > 0) insertAtCursor(pendingText)
      }

      const paste = feedPasteChunk(pasteRef.current, input)
      if (paste.consumed) {
        for (const part of paste.parts) {
          if (part.kind === "text") {
            insertAtCursor(sanitizeTerminalText(part.value))
            continue
          }
          const content = sanitizeTerminalText(normalizePaste(part.value))
          if (shouldCollapsePaste(content)) {
            const id = pasteIdRef.current
            pasteIdRef.current += 1
            pasteStoreRef.current.set(id, content)
            insertAtCursor(formatPastePill(id, content))
          } else {
            insertAtCursor(content)
          }
        }
        return
      }

      if (action !== undefined) {
        handleAction(action)
        return
      }

      if (key.ctrl || key.meta) return
      if (input.length === 0) return

      insertAtCursor(sanitizeTerminalText(input.replace(/\r\n?/g, "\n")))
    },
    { isActive },
  )

  const showCompletions = value.startsWith("/") && !value.includes(" ")
  const completions = showCompletions ? matchCommands(value, skills) : []

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.text.accent}>{"❯ "}</Text>
        <Text>{renderWithCursor(value, cursor, !isActive, theme.text.muted, theme.colorsEnabled)}</Text>
      </Box>
      {completions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {completions.slice(0, 6).map((command) => (
            <Text key={command.name} color={theme.text.muted}>
              /{sanitizeTerminalText(command.name)} — {sanitizeTerminalText(command.description)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

function renderWithCursor(
  value: string,
  cursor: number,
  disabled: boolean,
  mutedColor: string | undefined,
  colorsEnabled: boolean,
): React.ReactNode {
  if (disabled) return <Text color={mutedColor}>{value}</Text>
  const before = value.slice(0, cursor)
  const pill = pastePillStartingAt(value, cursor)
  const next = pill?.end ?? nextGraphemeBoundary(value, cursor)
  const at = value.slice(cursor, next) || " "
  const after = value.slice(next)
  if (!colorsEnabled)
    return (
      <Text>
        {before}▏{at}
        {after}
      </Text>
    )
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  )
}

function previousGraphemeBoundary(value: string, cursor: number): number {
  let previous = 0
  for (const segment of GRAPHEME_SEGMENTER.segment(value)) {
    if (segment.index >= cursor) break
    previous = segment.index
  }
  return previous
}

function nextGraphemeBoundary(value: string, cursor: number): number {
  for (const segment of GRAPHEME_SEGMENTER.segment(value)) {
    const end = segment.index + segment.segment.length
    if (end > cursor) return end
  }
  return value.length
}
