import React from "react"
import { Box, Text } from "ink"
import { Spinner, SPINNER_FRAMES, SPINNER_FRAME_INTERVAL_MS } from "@/ui/components/Spinner"
import { useTheme } from "@/ui/theme"
import type { ActivityState } from "@/ui/view"

const ELAPSED_THRESHOLD_MS = 2_000
const MODEL_WAIT_THRESHOLD_MS = 15_000

export function ActivityIndicator({
  activity,
  animations,
}: {
  activity: Exclude<ActivityState, { kind: "idle" }>
  animations: boolean
}): React.ReactElement {
  const theme = useTheme()
  const [now, setNow] = React.useState(Date.now)
  const startedAt = activity.startedAt
  const lastModelActivityAt = activity.kind === "turn" ? activity.lastModelActivityAt : undefined

  React.useEffect(() => {
    setNow(Date.now())
    if (animations && SPINNER_FRAMES.length > 1) {
      const interval = setInterval(() => setNow(Date.now()), SPINNER_FRAME_INTERVAL_MS)
      return () => clearInterval(interval)
    }

    const thresholds = [startedAt + ELAPSED_THRESHOLD_MS]
    if (lastModelActivityAt !== undefined) thresholds.push(lastModelActivityAt + MODEL_WAIT_THRESHOLD_MS)
    const timers = thresholds
      .map((threshold) => threshold - Date.now())
      .filter((delay) => delay > 0)
      .map((delay) => setTimeout(() => setNow(Date.now()), delay))
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [animations, lastModelActivityAt, startedAt])

  const waitingForModel = activity.kind === "turn" && now - activity.lastModelActivityAt >= MODEL_WAIT_THRESHOLD_MS
  const label = activity.kind === "compaction" ? "Compacting" : waitingForModel ? "Waiting for model" : "Thinking"
  const elapsedSeconds = Math.floor((now - startedAt) / 1_000)
  const frame = Math.floor((now - startedAt) / SPINNER_FRAME_INTERVAL_MS)

  return (
    <Box marginTop={1}>
      <Text color={waitingForModel ? theme.status.warn : theme.status.pending}>
        <Spinner frame={frame} animated={animations} /> {label}
        {elapsedSeconds >= 2 ? ` · ${elapsedSeconds}s` : ""}
      </Text>
    </Box>
  )
}
