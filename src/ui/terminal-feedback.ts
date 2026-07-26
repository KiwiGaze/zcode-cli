import { sanitizeTerminalTitle } from "@/ui/terminal-text"
import type { ActivityState, OperationCompletion } from "@/ui/view"

const ESCAPE = "\u001b"
const BELL = "\u0007"
const ENABLE_FOCUS_REPORTING = `${ESCAPE}[?1004h`
const DISABLE_FOCUS_REPORTING = `${ESCAPE}[?1004l`
const PROGRESS_ACTIVE = `${ESCAPE}]9;4;3${BELL}`
const PROGRESS_CLEAR = `${ESCAPE}]9;4;0;${BELL}`
const PROGRESS_KEEPALIVE_MS = 1_000

export interface TerminalFeedbackState {
  activity: ActivityState
  permissionId?: string
  completion: OperationCompletion | null
  queuedInputCount: number
  hasAutonomy: boolean
}

export interface TerminalFeedback {
  update(state: TerminalFeedbackState): void
  setFocused(focused: boolean): void
  dispose(): void
}

export interface TerminalFeedbackOptions {
  isTTY: boolean
  write: (data: string) => void
  attention: "always" | "blurred" | "off"
  terminalProgress: boolean
  registerExitHandler?: (handler: () => void) => () => void
}

export function createTerminalFeedback(options: TerminalFeedbackOptions): TerminalFeedback {
  if (!options.isTTY) {
    return {
      update() {},
      setFocused() {},
      dispose() {},
    }
  }

  let disposed = false
  let focused = true
  let currentTitle = ""
  let currentPermissionId: string | undefined
  let lastCompletionId = 0
  let doneTitleCompletionId: number | undefined
  let progressTimer: ReturnType<typeof setInterval> | undefined
  const focusReportingEnabled = options.attention === "blurred"

  const writeTitle = (title: string): void => {
    const safeTitle = sanitizeTerminalTitle(title)
    if (safeTitle === currentTitle) return
    currentTitle = safeTitle
    options.write(`${ESCAPE}]2;${safeTitle}${BELL}`)
  }

  const clearProgress = (): void => {
    if (progressTimer === undefined) return
    clearInterval(progressTimer)
    progressTimer = undefined
    options.write(PROGRESS_CLEAR)
  }

  const startProgress = (): void => {
    if (!options.terminalProgress || progressTimer !== undefined) return
    options.write(PROGRESS_ACTIVE)
    progressTimer = setInterval(() => options.write(PROGRESS_ACTIVE), PROGRESS_KEEPALIVE_MS)
  }

  const ring = (): void => {
    if (options.attention === "off") return
    if (options.attention === "blurred" && focused) return
    options.write(BELL)
  }

  const cleanup = (): void => {
    if (disposed) return
    disposed = true
    clearProgress()
    if (focusReportingEnabled) options.write(DISABLE_FOCUS_REPORTING)
    writeTitle("zcode")
  }

  const registerExitHandler =
    options.registerExitHandler ??
    ((handler: () => void) => {
      process.on("exit", handler)
      return () => process.removeListener("exit", handler)
    })
  const unregisterExitHandler = registerExitHandler(cleanup)

  if (focusReportingEnabled) options.write(ENABLE_FOCUS_REPORTING)
  writeTitle("zcode")

  return {
    update(state): void {
      if (disposed) return
      const hasPermission = state.permissionId !== undefined
      const isActive = state.activity.kind !== "idle" && !hasPermission

      if (hasPermission) {
        doneTitleCompletionId = undefined
        clearProgress()
        writeTitle("zcode · input needed")
        if (state.permissionId !== currentPermissionId) ring()
      } else if (isActive) {
        doneTitleCompletionId = undefined
        startProgress()
        writeTitle("zcode · working")
      } else {
        clearProgress()
      }
      currentPermissionId = state.permissionId

      const completion = state.completion
      if (completion !== null && completion.id !== lastCompletionId) {
        if (state.queuedInputCount > 0) {
          lastCompletionId = completion.id
        } else if (!state.hasAutonomy) {
          lastCompletionId = completion.id
          if (completion.outcome === "completed") {
            doneTitleCompletionId = completion.id
            writeTitle("zcode · done")
            ring()
          } else {
            doneTitleCompletionId = undefined
            writeTitle("zcode")
          }
        }
      }

      if (
        !hasPermission &&
        !isActive &&
        !state.hasAutonomy &&
        (completion === null || completion.id !== doneTitleCompletionId)
      ) {
        writeTitle("zcode")
      }
    },
    setFocused(nextFocused): void {
      focused = nextFocused
    },
    dispose(): void {
      unregisterExitHandler()
      cleanup()
    },
  }
}
