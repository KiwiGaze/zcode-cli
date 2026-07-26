import { test, expect } from "bun:test"
import { PassThrough } from "node:stream"
import { render as renderInk } from "ink"
import { render } from "ink-testing-library"
import { InputBox } from "@/ui/components/InputBox"

function tick(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForText(read: () => string | undefined, text: string): Promise<void> {
  const timeoutAt = Date.now() + 1_000
  while (!read()?.includes(text)) {
    if (Date.now() >= timeoutAt)
      throw new Error(
        `Timed out waiting for text containing ${JSON.stringify(text)}; last value: ${JSON.stringify(read())}`,
      )
    await tick(20)
  }
}

function waitForFrame(view: ReturnType<typeof render>, text: string): Promise<void> {
  return waitForText(() => view.lastFrame(), text)
}

function mount() {
  let submitted: string | null = null
  const view = render(
    <InputBox
      onSubmit={(value) => (submitted = value)}
      onAbort={() => []}
      onRestoreQueue={() => []}
      onFocusChange={() => {}}
      focusReporting={false}
      busy={false}
      isActive
    />,
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
const CR = String.fromCharCode(13)
const BACKSPACE = String.fromCharCode(8)
const DELETE = ESC + "[3~"
const LEFT = ESC + "[D"
const RIGHT = ESC + "[C"
const wrapPaste = (content: string) => ESC + "[200~" + content + ESC + "[201~"

function isEnvironmentFlagEnabled(name: "CI" | "CONTINUOUS_INTEGRATION"): boolean {
  const value = process.env[name]
  return value !== undefined && value !== "0" && value !== "false"
}

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

test("control keys sharing a chunk with a paste terminator cannot submit the paste", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(wrapPaste("one\ntwo\nthree") + CR)
  await tick()
  expect(submit()).toBeNull()

  view.stdin.write(CR)
  await tick()
  expect(submit()).toBe("one\ntwo\nthree")
  view.unmount()
})

test("control sequences sharing a chunk with a paste terminator cannot move the paste pill", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(wrapPaste("one\ntwo\nthree") + LEFT)
  view.stdin.write(" after")
  view.stdin.write(CR)
  await tick()

  expect(submit()).toBe("one\ntwo\nthree after")
  view.unmount()
})

test("an embedded paste terminator cannot turn pasted carriage returns into submission", async () => {
  const { view, submit } = mount()
  await tick()

  const embeddedTerminator = `${ESC}[201~`
  view.stdin.write(wrapPaste(`safe${embeddedTerminator}\rmalicious`))
  await tick()
  expect(submit()).toBeNull()

  view.stdin.write(CR)
  await tick()
  expect(submit()).toBe("safemalicious")
  view.unmount()
})

test("bracketed paste split across chunks assembles into one paste", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(ESC + "[200~part one\n")
  view.stdin.write("part two")
  view.stdin.write(ESC + "[201~")
  view.stdin.write(CR)
  await tick()

  expect(submit()).toBe("part one\npart two")
  view.unmount()
})

test("hostile terminal controls are removed before pasted input is rendered or submitted", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(wrapPaste("safe\u001b]52;c;stolen\u0007"))
  await tick()
  expect(view.lastFrame()).not.toContain("stolen")
  expect(view.lastFrame()).not.toContain(ESC)

  view.stdin.write(CR)
  await tick()
  expect(submit()).toBe("safe")
  view.unmount()
})

test("ordinary text sharing a chunk with paste markers is preserved in order", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(`before${wrapPaste("one\ntwo\nthree")}after`)
  view.stdin.write(CR)
  await tick()

  expect(submit()).toBe("beforeone\ntwo\nthreeafter")
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
  await waitForFrame(view, "[Pasted #1")
  view.stdin.write("\r")
  await tick()
  expect(submit()).toBe("see x1\nx2\nx3\nx4\nx5")
  view.unmount()
})

test("a completed paste refreshes a normal Ink layout without another input", async () => {
  if (
    process.env["ZCODE_NORMAL_RENDER_PROBE"] !== "1" &&
    (isEnvironmentFlagEnabled("CI") || isEnvironmentFlagEnabled("CONTINUOUS_INTEGRATION"))
  ) {
    const probe = Bun.spawn(
      [process.execPath, "test", import.meta.path, "--test-name-pattern", "completed paste refreshes"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CI: "false",
          CONTINUOUS_INTEGRATION: "false",
          ZCODE_NORMAL_RENDER_PROBE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      probe.exited,
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`Normal-render probe failed.\n${stdoutText}\n${stderrText}`)
    return
  }

  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  })
  Object.assign(stdout, { isTTY: true, columns: 100, rows: 30 })

  let output = ""
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })

  const instance = renderInk(
    <InputBox
      onSubmit={() => {}}
      onAbort={() => []}
      onRestoreQueue={() => []}
      onFocusChange={() => {}}
      focusReporting={false}
      busy={false}
      isActive
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )

  try {
    await tick()
    output = ""
    stdin.write(wrapPaste("one\ntwo\nthree"))
    await waitForText(() => output, "[Pasted #1, 3 lines]")

    expect(output).toContain("[Pasted #1, 3 lines]")
  } finally {
    instance.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test("backspace next to a collapsed paste removes the whole pill", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write(wrapPaste("a\nb\nc\nd"))
  await tick()
  view.stdin.write(BACKSPACE)
  await tick()
  view.stdin.write("hi")
  await tick()
  view.stdin.write(CR)
  await tick()
  expect(submit()).toBe("hi")
  view.unmount()
})

test("Delete next to a collapsed paste removes the whole pill", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("A")
  view.stdin.write(wrapPaste("a\nb\nc\nd"))
  view.stdin.write("B")
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(DELETE)
  await tick()
  view.stdin.write(CR)
  await tick()

  expect(submit()).toBe("AB")
  view.unmount()
})

test("left and right arrows move across a collapsed paste atomically", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("A")
  view.stdin.write(wrapPaste("a\nb\nc\nd"))
  view.stdin.write("B")
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(LEFT)
  await tick()
  view.stdin.write(RIGHT)
  await tick()
  view.stdin.write("X")
  await tick()
  view.stdin.write(CR)
  await tick()

  expect(submit()).toBe("Aa\nb\nc\ndXB")
  view.unmount()
})

test("Alt+Enter inserts a newline instead of submitting", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("line one")
  await tick()
  view.stdin.write(ESC + CR)
  await tick()
  expect(submit()).toBeNull()

  view.stdin.write("line two")
  await tick()
  view.stdin.write(CR)
  await tick()
  expect(submit()).toBe("line one\nline two")
  view.unmount()
})

test("Ctrl+J (line feed) inserts a newline instead of submitting", async () => {
  const { view, submit } = mount()
  await tick()

  view.stdin.write("first")
  await tick()
  view.stdin.write(String.fromCharCode(10))
  await tick()
  expect(submit()).toBeNull()

  view.stdin.write("second")
  await tick()
  view.stdin.write(CR)
  await tick()
  expect(submit()).toBe("first\nsecond")
  view.unmount()
})
