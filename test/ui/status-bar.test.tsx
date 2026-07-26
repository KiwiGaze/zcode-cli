import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import { StatusBar } from "@/ui/components/StatusBar"
import type { StatusInfo } from "@/ui/view"

describe("StatusBar", () => {
  test("keeps model and context visible at narrow widths", () => {
    const { lastFrame } = render(
      <StatusBar
        status={status({
          context: { kind: "measured", tokens: 85, window: 100, compactAtRatio: 0.9 },
        })}
        activity={{ kind: "turn", startedAt: 1, lastModelActivityAt: 1 }}
        width={40}
      />,
    )
    const frame = lastFrame() ?? ""

    expect(frame).toContain("glm-5.2")
    expect(frame).toContain("ctx 85%")
    expect(frame).not.toContain("zai")
    expect(frame).not.toContain("cache")
  })

  test("truncates a long model without dropping narrow-width context", () => {
    const { lastFrame } = render(
      <StatusBar
        status={status({
          model: "vendor/model-with-a-name-that-exceeds-the-terminal",
          context: { kind: "measured", tokens: 85, window: 100, compactAtRatio: 0.9 },
        })}
        activity={{ kind: "idle" }}
        width={40}
      />,
    )
    const frame = lastFrame() ?? ""

    expect(frame).toContain("vendor/model")
    expect(frame).toContain("ctx 85%")
  })

  test("distinguishes estimated and post-compaction context", () => {
    const estimated = render(
      <StatusBar
        status={status({
          context: { kind: "estimated", tokens: 45, window: 100, compactAtRatio: 0.8 },
        })}
        activity={{ kind: "idle" }}
        width={80}
      />,
    )
    expect(estimated.lastFrame()).toContain("ctx ~45%")
    expect(estimated.lastFrame()).toContain("35% to compact")

    const unknown = render(
      <StatusBar
        status={status({
          context: { kind: "unknownAfterCompaction", window: 100, compactAtRatio: 0.8 },
        })}
        activity={{ kind: "idle" }}
        width={80}
      />,
    )
    expect(unknown.lastFrame()).toContain("ctx ? · compacted")
    expect(unknown.lastFrame()).not.toContain("to compact")
  })

  test("uses only the latest response for the cache ratio", () => {
    const { lastFrame } = render(
      <StatusBar
        status={status({
          usage: { input: 10_000, output: 100, reasoning: 0, cachedInput: 100 },
          latestResponseUsage: { input: 100, output: 1, reasoning: 0, cachedInput: 73 },
        })}
        activity={{ kind: "idle" }}
        width={100}
      />,
    )

    expect(lastFrame()).toContain("cache 73%")
  })

  test("hides unreported cache and never renders a negative compaction distance", () => {
    const { lastFrame } = render(
      <StatusBar
        status={status({
          latestResponseUsage: { input: 100, output: 1, reasoning: 0, cachedInput: 0 },
          context: { kind: "measured", tokens: 95, window: 100, compactAtRatio: 0.8 },
        })}
        activity={{ kind: "compaction", startedAt: 1 }}
        width={120}
      />,
    )
    const frame = lastFrame() ?? ""

    expect(frame).not.toContain("cache")
    expect(frame).toContain("compacting")
    expect(frame).not.toContain("-%")
  })
})

function status(overrides: Partial<StatusInfo> = {}): StatusInfo {
  return {
    provider: "zai",
    model: "glm-5.2",
    usage: { input: 100, output: 25, reasoning: 0, cachedInput: 0 },
    costUsd: 0.01,
    planMode: false,
    autoMode: false,
    context: { kind: "measured", tokens: 50, window: 100, compactAtRatio: 0.8 },
    ...overrides,
  }
}
