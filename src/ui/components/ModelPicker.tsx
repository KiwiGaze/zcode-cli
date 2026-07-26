import React from "react"
import { Box, Text, useInput } from "ink"
import { resolveKeyAction } from "@/ui/keybindings"
import { sanitizeTerminalText } from "@/ui/terminal-text"
import { useTheme } from "@/ui/theme"
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "@/llm/providers"

export interface ModelOption {
  provider: ProviderId
  model: string
}

export function buildModelOptions(models: string[]): ModelOption[] {
  const options: ModelOption[] = []
  for (const provider of PROVIDER_IDS) {
    for (const model of models) options.push({ provider, model })
  }
  return options
}

export function ModelPicker({
  options,
  current,
  onSelect,
  onCancel,
  onFocusChange,
  focusReporting,
  isActive,
}: {
  options: ModelOption[]
  current: ModelOption
  onSelect: (option: ModelOption) => void
  onCancel: () => void
  onFocusChange: (focused: boolean) => void
  focusReporting: boolean
  isActive: boolean
}): React.ReactElement {
  const theme = useTheme()
  const initial = Math.max(
    0,
    options.findIndex((option) => option.provider === current.provider && option.model === current.model),
  )
  const [index, setIndex] = React.useState(initial)

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
      if (action === "picker.cancel") {
        onCancel()
        return
      }
      if (action === "picker.previous" && options.length > 0) setIndex((i) => (i - 1 + options.length) % options.length)
      else if (action === "picker.next" && options.length > 0) setIndex((i) => (i + 1) % options.length)
      else if (action === "picker.accept") {
        const chosen = options[index]
        if (chosen !== undefined) onSelect(chosen)
      }
    },
    { isActive },
  )

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text.accent}>select model (↑/↓, enter, esc)</Text>
      {options.map((option, i) => {
        const selected = i === index
        return (
          <Text key={`${option.provider}:${option.model}`} color={selected ? theme.text.accent : undefined}>
            {selected ? "❯ " : "  "}
            {sanitizeTerminalText(PROVIDERS[option.provider].name)} · {sanitizeTerminalText(option.model)}
          </Text>
        )
      })}
    </Box>
  )
}
