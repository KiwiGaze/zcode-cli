import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import { ToolCard } from "@/ui/components/ToolCard"
import type { ToolView } from "@/ui/view"

describe("ToolCard", () => {
  test("shows the sanitized tail of completed bash output", () => {
    const tool = toolView({
      name: "bash",
      title: "printf output",
      result: {
        status: "ok",
        output: "first\nsecond\n\u001b]52;c;stolen\u0007third\nfourth",
      },
    })
    const { lastFrame } = render(<ToolCard tool={tool} live={false} animations={false} />)
    const frame = lastFrame() ?? ""

    expect(frame).not.toContain("first")
    expect(frame).not.toContain("\u001b")
    expect(frame).toContain("second")
    expect(frame).toContain("third")
    expect(frame).toContain("fourth")
    expect(frame).toContain("output truncated")
  })

  test("summarizes read results without exposing model-facing wrappers", () => {
    const tool = toolView({
      name: "read",
      title: "src/index.ts",
      result: {
        status: "ok",
        output: "<path>/project/src/index.ts</path>\n<content>\nsecret model payload\n</content>",
      },
    })
    const { lastFrame } = render(<ToolCard tool={tool} live={false} animations={false} />)
    const frame = lastFrame() ?? ""

    expect(frame).toContain("src/index.ts")
    expect(frame).not.toContain("<content>")
    expect(frame).not.toContain("secret model payload")
  })

  test("keeps bounded errors visible for compact tools", () => {
    const tool = toolView({
      name: "grep",
      status: "error",
      title: "needle",
      result: {
        status: "error",
        output: "search failed\nline two\nline three\nline four",
      },
    })
    const { lastFrame } = render(<ToolCard tool={tool} live={false} animations={false} />)
    const frame = lastFrame() ?? ""

    expect(frame).toContain("search failed")
    expect(frame).toContain("output truncated")
    expect(frame).not.toContain("line four")
  })

  test("renders successful edits as replacement diffs from structured input", () => {
    const tool = toolView({
      name: "edit",
      input: {
        filePath: "/project/example.ts",
        oldString: "const state = oldValue\n",
        newString: "const state = newValue\n",
        replaceAll: true,
      },
      title: "example.ts (+1 -1)",
      result: {
        status: "ok",
        output: "Edit applied successfully.",
        metadata: { path: "/project/example.ts", additions: 1, deletions: 1 },
      },
    })
    const { lastFrame } = render(<ToolCard tool={tool} live={false} animations={false} />)
    const frame = lastFrame() ?? ""

    expect(frame).toContain("replacement diff · all occurrences")
    expect(frame).toContain("/project/example.ts")
    expect(frame).toContain("- const state = oldValue")
    expect(frame).toContain("+ const state = newValue")
  })
})

function toolView(overrides: Partial<ToolView>): ToolView {
  return {
    callId: "call-1",
    name: "read",
    input: {},
    status: "ok",
    title: "",
    progress: "",
    ...overrides,
  }
}
