import { expect, test } from "bun:test"
import { render } from "ink-testing-library"
import { InputBox, type InputBoxProps } from "@/ui/components/InputBox"
import { resolveTheme, ThemeContext } from "@/ui/theme"

const ESC = String.fromCharCode(27)
const ENTER = String.fromCharCode(13)
const BACKSPACE = String.fromCharCode(8)
const DELETE = ESC + "[3~"
const LEFT = ESC + "[D"
const UP = ESC + "[A"
const DOWN = ESC + "[B"
const ALT_UP = ESC + ESC + "[A"

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function mount(overrides: Partial<InputBoxProps> = {}) {
  const submitted: string[] = []
  const props: InputBoxProps = {
    onSubmit: (value) => submitted.push(value),
    onAbort: () => [],
    onRestoreQueue: () => [],
    onFocusChange: () => {},
    focusReporting: false,
    busy: false,
    isActive: true,
    ...overrides,
  }
  const view = render(<InputBox {...props} />)
  return { view, submitted }
}

test.each([
  ["an emoji ZWJ sequence", "A👨‍👩‍👧‍👦B"],
  ["a combining sequence", "Ae\u0301B"],
  ["a variation selector sequence", "A✈️B"],
  ["a CJK grapheme", "A中B"],
])("Backspace removes %s as one grapheme", async (_label, value) => {
  const { view, submitted } = mount()
  await tick()

  view.stdin.write(value)
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(BACKSPACE)
  await tick()
  view.stdin.write(ENTER)
  await tick()

  expect(submitted).toEqual(["AB"])
  view.unmount()
})

test("Delete removes the grapheme after the cursor", async () => {
  const { view, submitted } = mount()
  await tick()

  view.stdin.write("A👨‍👩‍👧‍👦B")
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(DELETE)
  await tick()
  view.stdin.write(ENTER)
  await tick()

  expect(submitted).toEqual(["AB"])
  view.unmount()
})

test.each(["👨‍👩‍👧‍👦", "e\u0301", "✈️", "中"])("cursor rendering keeps %s intact", async (grapheme) => {
  const { view } = mount()
  await tick()

  view.stdin.write(`${grapheme}B`)
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(LEFT)
  await tick()

  expect(view.lastFrame()).toContain(grapheme)
  view.unmount()
})

test("history navigation restores the draft at the newest position", async () => {
  const { view, submitted } = mount()
  await tick()

  view.stdin.write("submitted")
  await tick()
  view.stdin.write(ENTER)
  view.stdin.write("unfinished draft")
  await tick()
  view.stdin.write(UP)
  await tick()
  view.stdin.write(DOWN)
  await tick()
  view.stdin.write(ENTER)
  await tick()

  expect(submitted).toEqual(["submitted", "unfinished draft"])
  view.unmount()
})

test("Alt+Up prepends restored queue drafts without submitting", async () => {
  let restoreCount = 0
  const { view, submitted } = mount({
    onRestoreQueue: () => {
      restoreCount += 1
      return ["queued one", "queued two"]
    },
  })
  await tick()

  view.stdin.write("current draft")
  await tick()
  view.stdin.write(ALT_UP)
  await tick()

  expect(restoreCount).toBe(1)
  expect(submitted).toEqual([])

  view.stdin.write(ENTER)
  await tick()
  expect(submitted).toEqual(["queued one\n\nqueued two\n\ncurrent draft"])
  view.unmount()
})

test("aborting prepends synchronously restored queue drafts", async () => {
  let abortCount = 0
  const { view, submitted } = mount({
    busy: true,
    onAbort: () => {
      abortCount += 1
      return ["queued"]
    },
  })
  await tick()

  view.stdin.write("current")
  await tick()
  view.stdin.write(ESC)
  await tick()

  expect(abortCount).toBe(1)
  expect(submitted).toEqual([])

  view.stdin.write(ENTER)
  await tick()
  expect(submitted).toEqual(["queued\n\ncurrent"])
  view.unmount()
})

test("focus reporting tokens notify the owner and never enter the draft", async () => {
  const focusStates: boolean[] = []
  const { view, submitted } = mount({
    focusReporting: true,
    onFocusChange: (focused) => focusStates.push(focused),
  })
  await tick()

  view.stdin.write(ESC + "[O")
  await tick()
  view.stdin.write(ESC + "[I")
  await tick()
  view.stdin.write("kept")
  await tick()
  view.stdin.write(ENTER)
  await tick()

  expect(focusStates).toEqual([false, true])
  expect(submitted).toEqual(["kept"])
  view.unmount()
})

test("literal focus-like text remains editable when focus reporting is disabled", async () => {
  const { view, submitted } = mount()
  await tick()

  view.stdin.write("[I")
  await tick()
  view.stdin.write(ENTER)
  await tick()

  expect(submitted).toEqual(["[I"])
  view.unmount()
})

test("inactive input boxes do not consume keyboard input", async () => {
  const { view, submitted } = mount({ isActive: false })
  await tick()

  view.stdin.write("ignored")
  view.stdin.write(ENTER)
  await tick()

  expect(submitted).toEqual([])
  view.unmount()
})

test("colorless themes render a visible cursor without inverse styling", async () => {
  const theme = resolveTheme({ theme: "dark" }, { NO_COLOR: "1" })
  const view = render(
    <ThemeContext.Provider value={theme}>
      <InputBox
        onSubmit={() => {}}
        onAbort={() => []}
        onRestoreQueue={() => []}
        onFocusChange={() => {}}
        focusReporting={false}
        busy={false}
        isActive
      />
    </ThemeContext.Provider>,
  )
  await tick()

  view.stdin.write("A")
  await tick()

  expect(view.lastFrame()).toContain("A▏")
  expect(view.lastFrame()).not.toContain("\u001b[7m")
  view.unmount()
})
