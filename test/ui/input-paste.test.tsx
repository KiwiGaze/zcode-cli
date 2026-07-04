import { test, expect } from "bun:test"
import { render } from "ink-testing-library"
import { InputBox } from "@/ui/components/InputBox"

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mount() {
  let submitted: string | null = null
  const view = render(
    <InputBox onSubmit={(value) => (submitted = value)} onAbort={() => {}} busy={false} disabled={false} />,
  )
  return { view, submit: () => submitted }
}

test("carriage returns in a paste become newlines, nothing is dropped", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("alpha\rbravo\rcharlie")
  await tick()
  view.stdin.write("\r")
  await tick()

  expect(submit()).toBe("alpha\nbravo\ncharlie")
  expect(submit()).not.toContain("\r")
  view.unmount()
})

test("CRLF pastes are normalized to single newlines", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("alpha\r\nbravo")
  await tick()
  view.stdin.write("\r")
  await tick()

  expect(submit()).toBe("alpha\nbravo")
  view.unmount()
})

test("a multi-line paste does not submit until Enter is pressed", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("one\rtwo\rthree")
  await tick()
  expect(submit()).toBeNull()

  view.stdin.write("\r")
  await tick()
  expect(submit()).toBe("one\ntwo\nthree")
  view.unmount()
})

const ESC = String.fromCharCode(27)
const wrapPaste = (content: string) => ESC + "[200~" + content + ESC + "[201~"

test("bracketed paste is captured atomically and does not submit on its own", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(wrapPaste("one\ntwo\nthree\nfour"))
  await tick()
  expect(submit()).toBeNull()

  view.stdin.write("\r")
  await tick()
  expect(submit()).toBe("one\ntwo\nthree\nfour")
  view.unmount()
})

test("bracketed paste split across chunks assembles into one paste", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(ESC + "[200~part one\n")
  await tick()
  view.stdin.write("part two")
  await tick()
  view.stdin.write(ESC + "[201~")
  await tick()
  expect(submit()).toBeNull()

  view.stdin.write("\r")
  await tick()
  expect(submit()).toBe("part one\npart two")
  view.unmount()
})

test("bracketed paste normalizes CR line endings", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(wrapPaste("a\rb\r\nc"))
  await tick()
  view.stdin.write("\r")
  await tick()
  expect(submit()).toBe("a\nb\nc")
  view.unmount()
})

test("a collapsed paste expands in place when submitted alongside typed text", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("see ")
  await tick()
  view.stdin.write(wrapPaste("x1\nx2\nx3\nx4\nx5"))
  await tick()
  view.stdin.write("\r")
  await tick()
  expect(submit()).toBe("see x1\nx2\nx3\nx4\nx5")
  view.unmount()
})
