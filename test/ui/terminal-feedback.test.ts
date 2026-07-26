import { describe, expect, test } from "bun:test"
import { createTerminalFeedback, type TerminalFeedbackState } from "@/ui/terminal-feedback"

const ESCAPE = "\u001b"
const BELL = "\u0007"

describe("terminal feedback", () => {
  test("writes nothing and registers no lifecycle outside a TTY", () => {
    const writes: string[] = []
    let registered = false
    const feedback = createTerminalFeedback({
      isTTY: false,
      write: (value) => writes.push(value),
      attention: "blurred",
      terminalProgress: true,
      registerExitHandler: () => {
        registered = true
        return () => {}
      },
    })

    feedback.update(state({ activity: { kind: "turn", startedAt: 1, lastModelActivityAt: 1 } }))
    feedback.setFocused(false)
    feedback.dispose()

    expect(writes).toEqual([])
    expect(registered).toBe(false)
  })

  test("rings once for a permission only after blur under the default policy", () => {
    const harness = createHarness()
    harness.feedback.update(state({ permissionId: "call-1" }))
    expect(harness.writes.filter((value) => value === BELL)).toHaveLength(0)

    harness.feedback.setFocused(false)
    harness.feedback.update(state({ permissionId: "call-2" }))
    harness.feedback.update(state({ permissionId: "call-2" }))

    expect(harness.writes.filter((value) => value === BELL)).toHaveLength(1)
    expect(harness.writes.join("")).toContain("zcode · input needed")
    harness.feedback.dispose()
  })

  test("notifies only final successful completion", () => {
    const harness = createHarness({ attention: "always" })
    harness.feedback.update(
      state({
        activity: { kind: "turn", startedAt: 1, lastModelActivityAt: 1 },
      }),
    )
    harness.feedback.update(
      state({
        completion: { id: 1, kind: "turn", outcome: "completed" },
        queuedInputCount: 1,
      }),
    )
    harness.feedback.update(
      state({
        completion: { id: 1, kind: "turn", outcome: "completed" },
      }),
    )
    harness.feedback.update(
      state({
        completion: { id: 2, kind: "turn", outcome: "aborted" },
      }),
    )
    harness.feedback.update(
      state({
        completion: { id: 3, kind: "turn", outcome: "failed" },
      }),
    )
    harness.feedback.update(
      state({
        completion: { id: 4, kind: "turn", outcome: "completed" },
      }),
    )

    expect(harness.writes.filter((value) => value === BELL)).toHaveLength(1)
    expect(harness.writes.join("")).toContain("zcode · working")
    expect(harness.writes.join("")).toContain("zcode · done")
    harness.feedback.dispose()
  })

  test("defers the last autonomous completion until the driver becomes idle", () => {
    const harness = createHarness({ attention: "always" })
    const completion = { id: 1, kind: "turn", outcome: "completed" } as const

    harness.feedback.update(state({ completion, hasAutonomy: true }))
    expect(harness.writes.filter((value) => value === BELL)).toHaveLength(0)

    harness.feedback.update(state({ completion, hasAutonomy: false }))
    expect(harness.writes.filter((value) => value === BELL)).toHaveLength(1)
    harness.feedback.dispose()
  })

  test("an immediate idle transition clears a working title before async abort cleanup finishes", () => {
    const harness = createHarness({ attention: "always" })
    harness.feedback.update(
      state({
        activity: { kind: "turn", startedAt: 1, lastModelActivityAt: 1 },
      }),
    )
    harness.feedback.update(state())

    expect(harness.writes.at(-1)).toBe(`${ESCAPE}]2;zcode${BELL}`)
    expect(harness.writes.filter((value) => value === BELL)).toHaveLength(0)
    harness.feedback.dispose()
  })

  test("starts and clears optional progress around activity and permission", () => {
    const harness = createHarness({ terminalProgress: true })
    harness.feedback.update(
      state({
        activity: { kind: "turn", startedAt: 1, lastModelActivityAt: 1 },
      }),
    )
    harness.feedback.update(
      state({
        activity: { kind: "turn", startedAt: 1, lastModelActivityAt: 1 },
        permissionId: "call-1",
      }),
    )

    expect(harness.writes).toContain(`${ESCAPE}]9;4;3${BELL}`)
    expect(harness.writes).toContain(`${ESCAPE}]9;4;0;${BELL}`)
    harness.feedback.dispose()
  })

  test("cleanup is idempotent across exit and unmount", () => {
    const harness = createHarness({ terminalProgress: true })
    harness.feedback.update(
      state({
        activity: { kind: "compaction", startedAt: 1 },
      }),
    )
    const exitHandler = harness.exitHandler()
    expect(exitHandler).toBeDefined()
    exitHandler?.()
    const writesAfterExit = harness.writes.length

    harness.feedback.dispose()

    expect(harness.writes).toContain(`${ESCAPE}[?1004h`)
    expect(harness.writes).toContain(`${ESCAPE}[?1004l`)
    expect(harness.writes.join("")).toContain("zcode")
    expect(harness.writes).toHaveLength(writesAfterExit)
    expect(harness.unregistered()).toBe(true)
  })
})

function state(overrides: Partial<TerminalFeedbackState> = {}): TerminalFeedbackState {
  return {
    activity: { kind: "idle" },
    completion: null,
    queuedInputCount: 0,
    hasAutonomy: false,
    ...overrides,
  }
}

function createHarness(
  overrides: Partial<Pick<Parameters<typeof createTerminalFeedback>[0], "attention" | "terminalProgress">> = {},
) {
  const writes: string[] = []
  let handler: (() => void) | undefined
  let didUnregister = false
  const feedback = createTerminalFeedback({
    isTTY: true,
    write: (value) => writes.push(value),
    attention: overrides.attention ?? "blurred",
    terminalProgress: overrides.terminalProgress ?? false,
    registerExitHandler: (nextHandler) => {
      handler = nextHandler
      return () => {
        didUnregister = true
      }
    },
  })
  return {
    feedback,
    writes,
    exitHandler: () => handler,
    unregistered: () => didUnregister,
  }
}
