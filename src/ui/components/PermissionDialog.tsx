import React from "react"
import { Box, Text, useInput } from "ink"
import { resolveKeyAction } from "@/ui/keybindings"
import { sanitizeTerminalText } from "@/ui/terminal-text"
import { useTheme } from "@/ui/theme"
import type { PendingPermission } from "@/ui/view"
import type { PermissionDecision } from "@/permissions/types"

const CHOICES: { decision: PermissionDecision; label: string }[] = [
  { decision: "allow-once", label: "allow once" },
  { decision: "allow-session", label: "allow for this session" },
  { decision: "deny", label: "deny" },
]

export function PermissionDialog({
  pending,
  onDecide,
  onFocusChange,
  focusReporting,
  isActive,
}: {
  pending: PendingPermission
  onDecide: (decision: PermissionDecision) => void
  onFocusChange: (focused: boolean) => void
  focusReporting: boolean
  isActive: boolean
}): React.ReactElement {
  const theme = useTheme()
  const [index, setIndex] = React.useState(0)

  useInput(
    (input, key) => {
      const action = resolveKeyAction(input, key, { owner: "picker", focusReporting })
      if (action === "terminal.focus") {
        onFocusChange(true)
        return
      }
      if (action === "terminal.blur") {
        onFocusChange(false)
        return
      }
      if (action === "picker.previous") setIndex((i) => (i - 1 + CHOICES.length) % CHOICES.length)
      else if (action === "picker.next") setIndex((i) => (i + 1) % CHOICES.length)
      else if (action === "picker.cancel") onDecide("deny")
      else if (action === "picker.accept") {
        const chosen = CHOICES[index]
        if (chosen !== undefined) onDecide(chosen.decision)
      }
    },
    { isActive },
  )

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.status.warn} paddingX={1}>
      <Text color={theme.status.warn}>permission required</Text>
      <Text>{sanitizeTerminalText(pending.request.title)}</Text>
      {pending.request.detail !== undefined ? (
        <Text color={theme.text.muted}>{sanitizeTerminalText(pending.request.detail)}</Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {CHOICES.map((choice, i) => (
          <Text key={choice.decision} color={i === index ? theme.text.accent : undefined}>
            {i === index ? "❯ " : "  "}
            {choice.label}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
