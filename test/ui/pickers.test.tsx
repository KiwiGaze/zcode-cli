import { expect, test } from "bun:test"
import { render } from "ink-testing-library"
import { ModelPicker } from "@/ui/components/ModelPicker"
import { PermissionDialog } from "@/ui/components/PermissionDialog"
import { ResumePicker } from "@/ui/components/ResumePicker"
import type { SessionSummary } from "@/session/store"
import type { PendingPermission } from "@/ui/view"

const ESC = String.fromCharCode(27)
const DOWN = ESC + "[B"
const ENTER = String.fromCharCode(13)

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const timeoutAt = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() >= timeoutAt) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function hasSelectedRow(view: ReturnType<typeof render>, label: string): boolean {
  return (view.lastFrame() ?? "").split("\n").some((line) => line.includes("❯") && line.includes(label))
}

test("model and resume picker rows collapse untrusted line breaks", () => {
  const modelView = render(
    <ModelPicker
      options={[{ provider: "zai", model: "safe\nspoofed" }]}
      current={{ provider: "zai", model: "safe\nspoofed" }}
      onSelect={() => {}}
      onCancel={() => {}}
      onFocusChange={() => {}}
      focusReporting={false}
      isActive
    />,
  )
  const resumeView = render(
    <ResumePicker
      sessions={[sessionSummary(0, "safe\nspoofed")]}
      onSelect={() => {}}
      onCancel={() => {}}
      onFocusChange={() => {}}
      focusReporting={false}
      isActive
    />,
  )

  expect(modelView.lastFrame()).toContain("safe spoofed")
  expect(resumeView.lastFrame()).toContain("safe spoofed")
  expect(modelView.lastFrame()).not.toContain("safe\nspoofed")
  expect(resumeView.lastFrame()).not.toContain("safe\nspoofed")

  modelView.unmount()
  resumeView.unmount()
})

test("permission selection resets when the request changes", async () => {
  const decisions: string[] = []
  const first = pendingPermission("call-1")
  const second = pendingPermission("call-2")
  const view = render(
    <PermissionDialog
      key={first.request.callId}
      pending={first}
      onDecide={(decision) => decisions.push(decision)}
      onFocusChange={() => {}}
      focusReporting={false}
      isActive
    />,
  )
  await waitFor(() => hasSelectedRow(view, "allow once"), "the initial permission choice")

  view.stdin.write(DOWN)
  await waitFor(() => hasSelectedRow(view, "allow for this session"), "the next permission choice")
  view.rerender(
    <PermissionDialog
      key={second.request.callId}
      pending={second}
      onDecide={(decision) => decisions.push(decision)}
      onFocusChange={() => {}}
      focusReporting={false}
      isActive
    />,
  )
  view.stdin.write(ENTER)
  await waitFor(() => decisions.length === 1, "the permission decision")

  expect(decisions).toEqual(["allow-once"])
  view.unmount()
})

test("resume navigation wraps within the visible session window", async () => {
  const selected: SessionSummary[] = []
  const sessions = Array.from({ length: 12 }, (_, index) => sessionSummary(index, `session ${index}`))
  const view = render(
    <ResumePicker
      sessions={sessions}
      onSelect={(session) => selected.push(session)}
      onCancel={() => {}}
      onFocusChange={() => {}}
      focusReporting={false}
      isActive
    />,
  )
  await waitFor(() => hasSelectedRow(view, "session 0"), "the initial visible session")

  for (let index = 0; index < 10; index += 1) {
    view.stdin.write(DOWN)
    const expected = `session ${(index + 1) % 10}`
    await waitFor(() => hasSelectedRow(view, expected), `the selected row ${expected}`)
  }
  view.stdin.write(ENTER)
  await waitFor(() => selected.length === 1, "the selected session")

  expect(selected.map((session) => session.id)).toEqual(["session-0"])
  view.unmount()
})

function sessionSummary(index: number, preview: string): SessionSummary {
  return {
    id: `session-${index}`,
    createdAt: index,
    updatedAt: index,
    preview,
    file: `/tmp/session-${index}.jsonl`,
  }
}

function pendingPermission(callId: string): PendingPermission {
  return {
    request: {
      tool: "bash",
      callId,
      title: callId,
      key: callId,
      subject: callId,
    },
    respond: () => {},
  }
}
