import React from "react"
import { Box, Text, useInput } from "ink"
import { theme } from "@/ui/theme"
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
}: {
  options: ModelOption[]
  current: ModelOption
  onSelect: (option: ModelOption) => void
  onCancel: () => void
}): React.ReactElement {
  const initial = Math.max(
    0,
    options.findIndex((option) => option.provider === current.provider && option.model === current.model),
  )
  const [index, setIndex] = React.useState(initial)

  useInput((_input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.upArrow) setIndex((i) => (i - 1 + options.length) % options.length)
    else if (key.downArrow) setIndex((i) => (i + 1) % options.length)
    else if (key.return) {
      const chosen = options[index]
      if (chosen !== undefined) onSelect(chosen)
    }
  })

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.accent}>select model (↑/↓, enter, esc)</Text>
      {options.map((option, i) => {
        const selected = i === index
        return (
          <Text key={`${option.provider}:${option.model}`} color={selected ? theme.accent : undefined}>
            {selected ? "❯ " : "  "}
            {PROVIDERS[option.provider].name} · {option.model}
          </Text>
        )
      })}
    </Box>
  )
}
