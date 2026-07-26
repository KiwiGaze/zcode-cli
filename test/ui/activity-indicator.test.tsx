import { describe, expect, spyOn, test } from "bun:test"
import { render } from "ink-testing-library"
import { ActivityIndicator } from "@/ui/components/ActivityIndicator"

describe("ActivityIndicator", () => {
  test("animates every frame interval and clears the interval on unmount", async () => {
    let intervalCallback: (() => void) | undefined
    let now = 1_000
    const dateSpy = spyOn(Date, "now").mockImplementation(() => now)
    const captureInterval = ((callback: () => void, delay?: number): ReturnType<typeof setInterval> => {
      expect(delay).toBe(80)
      intervalCallback = callback as () => void
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as unknown as typeof setInterval
    const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(captureInterval)
    const clearIntervalSpy = spyOn(globalThis, "clearInterval")
    const tree = <ActivityIndicator activity={{ kind: "turn", startedAt: now, lastModelActivityAt: now }} animations />
    const view = render(tree)
    try {
      const firstFrame = view.lastFrame()
      now += 80
      intervalCallback?.()
      view.rerender(tree)

      expect(view.lastFrame()).not.toBe(firstFrame)
      view.unmount()
      expect(clearIntervalSpy).toHaveBeenCalled()
    } finally {
      view.unmount()
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
      dateSpy.mockRestore()
    }
  })

  test("uses a static glyph without creating a frame interval", () => {
    const setIntervalSpy = spyOn(globalThis, "setInterval")
    const startedAt = Date.now()
    const view = render(
      <ActivityIndicator activity={{ kind: "turn", startedAt, lastModelActivityAt: startedAt }} animations={false} />,
    )

    try {
      expect(view.lastFrame()).toContain("⋯ Thinking")
      expect(setIntervalSpy).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      setIntervalSpy.mockRestore()
    }
  })

  test("labels model silence as informational waiting and shows elapsed time", () => {
    const now = Date.now()
    const view = render(
      <ActivityIndicator
        activity={{
          kind: "turn",
          startedAt: now - 17_000,
          lastModelActivityAt: now - 15_001,
        }}
        animations={false}
      />,
    )

    expect(view.lastFrame()).toContain("Waiting for model")
    expect(view.lastFrame()).toContain("17s")
    expect(view.lastFrame()).not.toContain("error")
    view.unmount()
  })

  test("renders compaction as a distinct phase", () => {
    const view = render(
      <ActivityIndicator activity={{ kind: "compaction", startedAt: Date.now() }} animations={false} />,
    )

    expect(view.lastFrame()).toContain("Compacting")
    view.unmount()
  })
})
