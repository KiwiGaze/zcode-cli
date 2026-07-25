import { z } from "zod"
import { defineTool, type AnyTool } from "@/tools/registry"
import { okResult } from "@/tools/types"
import { clampWakeupDelay, WAKEUP_MAX_DELAY_SECONDS, WAKEUP_MIN_DELAY_SECONDS } from "@/agent/autonomy"

const DESCRIPTION = `Schedule when to resume work in /loop dynamic mode — you were invoked via /loop without an interval and are asked to self-pace.

Pass the same /loop prompt back via \`prompt\` so the next firing repeats the task. To end the loop, simply do not call this tool. delaySeconds is clamped to [${WAKEUP_MIN_DELAY_SECONDS}, ${WAKEUP_MAX_DELAY_SECONDS}].`

export interface WakeupRequest {
  delaySeconds: number
  reason: string
  prompt: string
}

const Schema = z.object({
  delaySeconds: z.number().describe("Seconds from now to wake up"),
  reason: z.string().describe("One short sentence explaining the chosen delay"),
  prompt: z.string().describe("The /loop prompt to run on wake-up; pass the same prompt to repeat the task"),
})
type Input = z.infer<typeof Schema>

/**
 * Registered only while a dynamic loop runs, so a call outside one hits `unknown tool`. Its only
 * effect is the callback: the driver, not the tool, owns the timer.
 */
export function createScheduleWakeupTool(onSchedule: (wakeup: WakeupRequest) => void): AnyTool {
  return defineTool<Input>({
    name: "schedulewakeup",
    description: DESCRIPTION,
    inputSchema: Schema,
    permission: () => null,
    execute: async (input) => {
      const delaySeconds = clampWakeupDelay(input.delaySeconds)
      onSchedule({ delaySeconds, reason: input.reason, prompt: input.prompt })
      return okResult(
        `Wakeup scheduled in ${delaySeconds}s. The loop will resume then; end your turn now.`,
        `Wakeup scheduled in ${delaySeconds}s`,
      )
    },
  })
}
