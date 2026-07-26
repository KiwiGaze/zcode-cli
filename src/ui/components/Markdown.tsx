import React from "react"
import { Box, Text } from "ink"
import { marked, type MarkedToken, type Token, type Tokens } from "marked"
import { highlight, supportsLanguage, type Theme as HighlightTheme } from "cli-highlight"
import { sanitizeTerminalText } from "@/ui/terminal-text"
import { useTheme, type SemanticTheme, type ThemeColor } from "@/ui/theme"

const NAMED_FOREGROUND_CODES: Readonly<Record<string, number>> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  white: 37,
  gray: 90,
  redBright: 91,
  greenBright: 92,
  blueBright: 94,
}

export function Markdown({ text, live }: { text: string; live: boolean }): React.ReactElement {
  const theme = useTheme()
  const sanitized = sanitizeTerminalText(text)
  const source = live ? stabilizePartialFence(sanitized) : sanitized
  const tokens = marked.lexer(source) as MarkedToken[]
  return <Box flexDirection="column">{renderBlocks(tokens, theme)}</Box>
}

function renderBlocks(tokens: MarkedToken[], theme: SemanticTheme): React.ReactNode[] {
  return tokens.flatMap((token, index) => {
    switch (token.type) {
      case "space":
      case "def":
        return []
      case "heading":
        return [
          <Text key={index} bold={theme.colorsEnabled}>
            {renderInline(asMarkedTokens(token.tokens), theme)}
          </Text>,
        ]
      case "paragraph":
      case "text":
        return [<Text key={index}>{renderInline(asMarkedTokens(token.tokens ?? []), theme)}</Text>]
      case "blockquote":
        return [
          <Box key={index} paddingLeft={1}>
            <Text>│ </Text>
            <Box flexDirection="column">{renderBlocks(asMarkedTokens(token.tokens), theme)}</Box>
          </Box>,
        ]
      case "list":
        return [<ListBlock key={index} token={token} theme={theme} />]
      case "code":
        return [<CodeBlock key={index} token={token} theme={theme} />]
      case "hr":
        return [<Text key={index}>────────</Text>]
      case "html":
        return [<Text key={index}>{token.text}</Text>]
      case "table":
        return [<Text key={index}>{token.raw}</Text>]
      default:
        return [<Text key={index}>{token.raw}</Text>]
    }
  })
}

function ListBlock({ token, theme }: { token: Tokens.List; theme: SemanticTheme }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {token.items.map((item, index) => (
        <Box key={index}>
          <Text>{token.ordered ? `${Number(token.start || 1) + index}. ` : "• "}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {renderBlocks(asMarkedTokens(item.tokens), theme)}
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function CodeBlock({ token, theme }: { token: Tokens.Code; theme: SemanticTheme }): React.ReactElement {
  return (
    <Box paddingLeft={2}>
      <Text>{highlightCode(token.text, token.lang, theme)}</Text>
    </Box>
  )
}

function highlightCode(code: string, language: string | undefined, theme: SemanticTheme): string {
  if (!theme.colorsEnabled) return code
  try {
    const normalizedLanguage = language?.trim().split(/\s+/)[0]
    return highlight(code, {
      ...(normalizedLanguage !== undefined && supportsLanguage(normalizedLanguage)
        ? { language: normalizedLanguage }
        : {}),
      ignoreIllegals: true,
      theme: syntaxHighlightTheme(theme),
    })
  } catch {
    return code
  }
}

function renderInline(tokens: MarkedToken[], theme: SemanticTheme): React.ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case "text":
        return token.tokens === undefined ? (
          token.text
        ) : (
          <React.Fragment key={index}>{renderInline(asMarkedTokens(token.tokens), theme)}</React.Fragment>
        )
      case "escape":
        return token.text
      case "br":
        return "\n"
      case "codespan":
        return (
          <Text key={index} inverse={theme.colorsEnabled}>
            {token.text}
          </Text>
        )
      case "em":
        return (
          <Text key={index} italic={theme.colorsEnabled}>
            {renderInline(asMarkedTokens(token.tokens), theme)}
          </Text>
        )
      case "strong":
        return (
          <Text key={index} bold={theme.colorsEnabled}>
            {renderInline(asMarkedTokens(token.tokens), theme)}
          </Text>
        )
      case "del":
        return (
          <Text key={index} strikethrough={theme.colorsEnabled}>
            {renderInline(asMarkedTokens(token.tokens), theme)}
          </Text>
        )
      case "link":
        return (
          <Text key={index} underline={theme.colorsEnabled}>
            {renderInline(asMarkedTokens(token.tokens), theme)} ({token.href})
          </Text>
        )
      case "image":
        return `${token.text} (${token.href})`
      default:
        return token.raw
    }
  })
}

function syntaxHighlightTheme(theme: SemanticTheme): HighlightTheme {
  const keyword = colorize(theme.syntax.keyword)
  const string = colorize(theme.syntax.string)
  const comment = colorize(theme.syntax.comment)
  const number = colorize(theme.syntax.number)
  const functionName = colorize(theme.syntax.function)
  const typeName = colorize(theme.syntax.type)
  return {
    keyword,
    built_in: typeName,
    type: typeName,
    literal: keyword,
    number,
    regexp: string,
    string,
    class: typeName,
    function: functionName,
    title: functionName,
    comment,
    doctag: comment,
    meta: comment,
    tag: comment,
    name: keyword,
    attr: typeName,
    emphasis: typeName,
    strong: typeName,
    link: typeName,
    addition: colorize(theme.diff.added),
    deletion: colorize(theme.diff.removed),
    default: (value) => value,
  }
}

function colorize(color: ThemeColor): (value: string) => string {
  if (color === undefined) return (value) => value
  const code = foregroundCode(color)
  return (value) => `\u001b[${code}m${value}\u001b[39m`
}

function foregroundCode(color: string): string {
  const namedCode = NAMED_FOREGROUND_CODES[color]
  if (namedCode !== undefined) return String(namedCode)
  const red = Number.parseInt(color.slice(1, 3), 16)
  const green = Number.parseInt(color.slice(3, 5), 16)
  const blue = Number.parseInt(color.slice(5, 7), 16)
  return `38;2;${red};${green};${blue}`
}

function asMarkedTokens(tokens: Token[]): MarkedToken[] {
  return tokens as MarkedToken[]
}

function stabilizePartialFence(source: string): string {
  return source.replace(/(^|\n)`{1,2}$/, "$1")
}
