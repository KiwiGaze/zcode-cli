import React from "react"
import { Box, Text, useInput } from "ink"
import { theme } from "@/ui/theme"
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
}: {
  pending: PendingPermission
  onDecide: (decision: PermissionDecision) => void
}): React.ReactElement {
  const [index, setIndex] = React.useState(0)

  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + CHOICES.length) % CHOICES.length)
    else if (key.downArrow) setIndex((i) => (i + 1) % CHOICES.length)
    else if (key.escape) onDecide("deny")
    else if (key.return) {
      const chosen = CHOICES[index]
      if (chosen !== undefined) onDecide(chosen.decision)
    }
  })

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.toolPending} paddingX={1}>
      <Text color={theme.toolPending}>permission required</Text>
      <Text>{pending.request.title}</Text>
      {pending.request.detail !== undefined ? <Text color={theme.dim}>{pending.request.detail}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {CHOICES.map((choice, i) => (
          <Text key={choice.decision} color={i === index ? theme.accent : undefined}>
            {i === index ? "❯ " : "  "}
            {choice.label}
          </Text>
        ))}
      </Box>
    </Box>
  )
}
