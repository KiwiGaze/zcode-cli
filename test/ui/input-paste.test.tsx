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
