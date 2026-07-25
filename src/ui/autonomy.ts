import {
  clampWakeupDelay,
  dynamicLoopDirective,
  goalDirective,
  goalJudgeUserMessage,
  goalRetryDirective,
  parseGoalVerdict,
  parseLoopInput,
  projectGoalTranscript,
  EVALUATOR_MAX_OUTPUT_TOKENS,
  GOAL_EVALUATOR_SYSTEM,
  GOAL_TRANSCRIPT_FRAMING,
  type LoopSpec,
} from "@/agent/autonomy"
import { estimateCost } from "@/agent/budget"
import { complete as defaultComplete, type CompleteFn } from "@/llm/complete"
import { baseUrl, requireApiKey } from "@/llm/providers"
import { createScheduleWakeupTool, type WakeupRequest } from "@/tools/schedule-wakeup"
import type { AppController } from "@/ui/controller"

const WAKEUP_TOOL = "schedulewakeup"

export type AutonomyStatus =
  | { kind: "goal"; condition: string; evaluation: number; maxEvaluations: number }
  | { kind: "loop"; mode: "interval" | "dynamic"; tick: number; maxTicks: number; nextInSeconds: number | undefined }

export interface AutonomyDriverOptions {
  complete?: CompleteFn
  /** Resolves true when the wait was interrupted. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<boolean>
}

export interface AutonomyDriver {
  runGoal(condition: string): Promise<void>
  runLoop(input: string): Promise<void>
  stop(): void
  status(): AutonomyStatus | undefined
  isActive(): boolean
}

export function createAutonomyDriver(host: AppController, options: AutonomyDriverOptions = {}): AutonomyDriver {
  const complete = options.complete ?? defaultComplete
  const sleep = options.sleep ?? realSleep
  let current: AutonomyStatus | undefined
  let stopper: AbortController | undefined

  const stopped = (): boolean => stopper === undefined || stopper.signal.aborted

  /** True when the session-wide cost budget has been reached; the loop's real spend guard. */
  const costExhausted = (): string | undefined => {
    const config = host.config_
    const limit = config.budget.maxCostUsd
    if (limit === undefined) return undefined
    const spent = estimateCost(config, config.model, host.session_().totalUsage)
    if (spent < limit) return undefined
    return `cost limit reached ($${spent.toFixed(4)} >= $${limit.toFixed(2)} budget) — stopping`
  }

  const evaluate = async (condition: string, signal: AbortSignal): Promise<ReturnType<typeof parseGoalVerdict>> => {
    const config = host.config_
    try {
      const raw = await complete({
        provider: config.provider,
        model: config.model,
        endpointKind: config.endpointKind,
        baseUrl: baseUrl(config.provider, config.endpointKind),
        apiKey: requireApiKey(config.provider, config),
        system: GOAL_EVALUATOR_SYSTEM,
        messages: [
          { role: "user", content: GOAL_TRANSCRIPT_FRAMING },
          { role: "assistant", content: projectGoalTranscript(host.session_().items) },
          { role: "user", content: goalJudgeUserMessage(condition) },
        ],
        maxOutputTokens: EVALUATOR_MAX_OUTPUT_TOKENS,
        temperature: 0,
        signal,
      })
      return parseGoalVerdict(raw)
    } catch {
      // An evaluator that cannot answer has not cleared the goal.
      return { ok: false, reason: "evaluator call failed", impossible: false }
    }
  }

  const begin = (): AbortController | undefined => {
    if (current !== undefined || host.isBusy()) {
      host.addNotice("an autonomous run is already active — press Esc to stop it first", "warn")
      return undefined
    }
    stopper = new AbortController()
    return stopper
  }

  const finish = (): void => {
    current = undefined
    stopper = undefined
  }

  return {
    async runGoal(condition) {
      const trimmed = condition.trim()
      if (trimmed.length === 0) {
        host.addNotice(current?.kind === "goal" ? `goal: ${current.condition}` : "no goal is active")
        return
      }
      const control = begin()
      if (control === undefined) return

      const config = host.config_
      const maxEvaluations = config.autonomy.goalMaxEvaluations
      current = { kind: "goal", condition: trimmed, evaluation: 0, maxEvaluations }
      host.addNotice(`goal set: ${trimmed}`)

      try {
        await host.runAutonomyTurn(goalDirective(trimmed), `/goal ${trimmed}`)
        let evaluation = 0
        while (!stopped()) {
          // The turn is always judged before any cap decision, so the last turn is never unjudged.
          const verdict = await evaluate(trimmed, control.signal)
          evaluation += 1
          current = { kind: "goal", condition: trimmed, evaluation, maxEvaluations }
          if (stopped()) break

          if (verdict.ok) {
            host.addNotice(
              `goal achieved after ${evaluation} evaluation${evaluation === 1 ? "" : "s"}: ${verdict.reason}`,
            )
            return
          }
          if (verdict.impossible) {
            host.addNotice(`goal judged impossible: ${verdict.reason}`, "warn")
            return
          }
          if (evaluation >= maxEvaluations) {
            host.addNotice(`goal stopped after ${maxEvaluations} evaluations: ${verdict.reason}`, "warn")
            return
          }
          const exhausted = costExhausted()
          if (exhausted !== undefined) {
            host.addNotice(exhausted, "warn")
            return
          }
          await host.runAutonomyTurn(goalRetryDirective(verdict.reason))
        }
        host.addNotice("goal stopped", "warn")
      } finally {
        finish()
      }
    },

    async runLoop(input) {
      const spec = parseLoopInput(input)
      if ("error" in spec) {
        host.addNotice(spec.error, "warn")
        return
      }
      const control = begin()
      if (control === undefined) return
      try {
        if (spec.mode === "interval") await runInterval(spec, control.signal)
        else await runDynamic(spec, control.signal)
      } finally {
        finish()
      }
    },

    stop() {
      stopper?.abort()
    },

    status() {
      return current
    },

    isActive() {
      return current !== undefined
    },
  }

  async function runInterval(spec: LoopSpec, signal: AbortSignal): Promise<void> {
    const maxTicks = host.config_.autonomy.loopMaxTicks
    const label = spec.intervalLabel ?? `${spec.intervalSeconds ?? 0}s`
    host.addNotice(`loop started (every ${label})`)
    let tick = 0
    let first = true

    while (!stopped()) {
      tick += 1
      current = { kind: "loop", mode: "interval", tick, maxTicks, nextInSeconds: undefined }
      await host.runAutonomyTurn(spec.prompt, first ? `/loop ${label} ${spec.prompt}` : undefined)
      first = false
      if (stopped()) break

      const stop = tickGuard(tick, maxTicks)
      if (stop !== undefined) {
        host.addNotice(stop, "warn")
        return
      }
      const seconds = spec.intervalSeconds ?? 0
      current = { kind: "loop", mode: "interval", tick, maxTicks, nextInSeconds: seconds }
      if (await sleep(seconds * 1000, signal)) break
    }
    host.addNotice("loop stopped")
  }

  async function runDynamic(spec: LoopSpec, signal: AbortSignal): Promise<void> {
    const runtime = host.runtime_()
    if (runtime.registry.has(WAKEUP_TOOL)) {
      host.addNotice(`cannot start a dynamic loop: a ${WAKEUP_TOOL} tool is already registered`, "warn")
      return
    }

    const maxTicks = host.config_.autonomy.loopMaxTicks
    let wakeup: WakeupRequest | undefined
    /** Read-and-clear, so each tick sees only what that tick scheduled. */
    const takeWakeup = (): WakeupRequest | undefined => {
      const request = wakeup
      wakeup = undefined
      return request
    }
    runtime.registry.register(
      createScheduleWakeupTool((request) => {
        wakeup = request
      }),
    )

    try {
      host.addNotice("loop started (self-paced)")
      let tick = 0
      let prompt = spec.prompt

      while (!stopped()) {
        tick += 1
        takeWakeup()
        current = { kind: "loop", mode: "dynamic", tick, maxTicks, nextInSeconds: undefined }
        await host.runAutonomyTurn(dynamicLoopDirective(prompt), tick === 1 ? `/loop ${spec.prompt}` : undefined)
        if (stopped()) break

        // No wakeup scheduled means the model considers the task done.
        const scheduled = takeWakeup()
        if (scheduled === undefined) {
          host.addNotice(`loop converged after ${tick} tick${tick === 1 ? "" : "s"}`)
          return
        }

        const stop = tickGuard(tick, maxTicks)
        if (stop !== undefined) {
          host.addNotice(stop, "warn")
          return
        }
        prompt = scheduled.prompt.trim().length > 0 ? scheduled.prompt : prompt
        const delay = clampWakeupDelay(scheduled.delaySeconds)
        current = { kind: "loop", mode: "dynamic", tick, maxTicks, nextInSeconds: delay }
        if (await sleep(delay * 1000, signal)) break
      }
      host.addNotice("loop stopped")
    } finally {
      runtime.registry.unregister(WAKEUP_TOOL)
    }
  }

  function tickGuard(tick: number, maxTicks: number): string | undefined {
    if (tick >= maxTicks) return `loop stopped after ${maxTicks} ticks`
    return costExhausted()
  }
}

function realSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve(false)
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
