import React from "react"
import type { Config } from "@/config/config"

export type TerminalEnvironment = Readonly<Record<string, string | undefined>>
export type ThemePreference = Config["ui"]["theme"]
export type ThemeColor = string | undefined

export interface SemanticTheme {
  readonly colorsEnabled: boolean
  readonly text: {
    readonly primary: ThemeColor
    readonly muted: ThemeColor
    readonly accent: ThemeColor
  }
  readonly status: {
    readonly ok: ThemeColor
    readonly warn: ThemeColor
    readonly error: ThemeColor
    readonly pending: ThemeColor
  }
  readonly diff: {
    readonly added: ThemeColor
    readonly removed: ThemeColor
    readonly addedWord: ThemeColor
    readonly removedWord: ThemeColor
    readonly context: ThemeColor
  }
  readonly syntax: {
    readonly keyword: ThemeColor
    readonly string: ThemeColor
    readonly comment: ThemeColor
    readonly number: ThemeColor
    readonly function: ThemeColor
    readonly type: ThemeColor
  }
}

export interface TerminalColorCapabilities {
  readonly colorsEnabled: boolean
  readonly truecolor: boolean
}

type UiThemeOptions = Pick<Config["ui"], "theme">
type Palette = Omit<SemanticTheme, "colorsEnabled">

const DARK_TRUECOLOR: Palette = {
  text: { primary: "#e6edf3", muted: "#8b949e", accent: "#6c9ee0" },
  status: { ok: "#7ee787", warn: "#d29922", error: "#f85149", pending: "#a5d6ff" },
  diff: {
    added: "#7ee787",
    removed: "#ffa198",
    addedWord: "#aff5b4",
    removedWord: "#ffdcd7",
    context: "#8b949e",
  },
  syntax: {
    keyword: "#ff7b72",
    string: "#a5d6ff",
    comment: "#8b949e",
    number: "#79c0ff",
    function: "#d2a8ff",
    type: "#ffa657",
  },
} as const satisfies Palette

const LIGHT_TRUECOLOR: Palette = {
  text: { primary: "#24292f", muted: "#57606a", accent: "#0969da" },
  status: { ok: "#1a7f37", warn: "#9a6700", error: "#cf222e", pending: "#0969da" },
  diff: {
    added: "#1a7f37",
    removed: "#cf222e",
    addedWord: "#4ac26b",
    removedWord: "#ff8182",
    context: "#57606a",
  },
  syntax: {
    keyword: "#cf222e",
    string: "#0a3069",
    comment: "#6e7781",
    number: "#0550ae",
    function: "#8250df",
    type: "#953800",
  },
} as const satisfies Palette

const DARK_ANSI_PALETTE: Palette = {
  text: { primary: "white", muted: "gray", accent: "blue" },
  status: { ok: "green", warn: "yellow", error: "red", pending: "blue" },
  diff: {
    added: "green",
    removed: "red",
    addedWord: "greenBright",
    removedWord: "redBright",
    context: "gray",
  },
  syntax: {
    keyword: "red",
    string: "blue",
    comment: "gray",
    number: "blueBright",
    function: "magenta",
    type: "yellow",
  },
} as const satisfies Palette

const LIGHT_ANSI_PALETTE: Palette = {
  text: { primary: "black", muted: "gray", accent: "blue" },
  status: { ok: "green", warn: "yellow", error: "red", pending: "blue" },
  diff: {
    added: "green",
    removed: "red",
    addedWord: "greenBright",
    removedWord: "redBright",
    context: "gray",
  },
  syntax: {
    keyword: "red",
    string: "blue",
    comment: "gray",
    number: "blueBright",
    function: "magenta",
    type: "yellow",
  },
} as const satisfies Palette

const COLORLESS_PALETTE: Palette = {
  text: { primary: undefined, muted: undefined, accent: undefined },
  status: { ok: undefined, warn: undefined, error: undefined, pending: undefined },
  diff: {
    added: undefined,
    removed: undefined,
    addedWord: undefined,
    removedWord: undefined,
    context: undefined,
  },
  syntax: {
    keyword: undefined,
    string: undefined,
    comment: undefined,
    number: undefined,
    function: undefined,
    type: undefined,
  },
} as const satisfies Palette

export function resolveTerminalColorCapabilities(
  environment: TerminalEnvironment = process.env,
): TerminalColorCapabilities {
  const colorsEnabled = (environment["NO_COLOR"]?.length ?? 0) === 0
  const colorTerminal = environment["COLORTERM"]?.toLowerCase()
  return {
    colorsEnabled,
    truecolor: colorsEnabled && (colorTerminal === "truecolor" || colorTerminal === "24bit"),
  }
}

export function resolveTheme(options: UiThemeOptions, environment: TerminalEnvironment = process.env): SemanticTheme {
  const capabilities = resolveTerminalColorCapabilities(environment)
  if (!capabilities.colorsEnabled) return { colorsEnabled: false, ...COLORLESS_PALETTE }

  const appearance = options.theme === "auto" ? resolveAutoAppearance(environment["COLORFGBG"]) : options.theme
  const palette =
    appearance === "light"
      ? capabilities.truecolor
        ? LIGHT_TRUECOLOR
        : LIGHT_ANSI_PALETTE
      : capabilities.truecolor
        ? DARK_TRUECOLOR
        : DARK_ANSI_PALETTE
  return { colorsEnabled: true, ...palette }
}

function resolveAutoAppearance(colorForegroundBackground: string | undefined): "dark" | "light" {
  const background = colorForegroundBackground?.split(";").at(-1)
  if (background === undefined || !/^\d+$/.test(background)) return "dark"
  const color = Number(background)
  return color < 7 || color === 8 ? "dark" : "light"
}

const DEFAULT_THEME = resolveTheme({ theme: "dark" })

export const ThemeContext = React.createContext<SemanticTheme>(DEFAULT_THEME)

export function useTheme(): SemanticTheme {
  return React.useContext(ThemeContext)
}
