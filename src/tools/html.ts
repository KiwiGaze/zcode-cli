function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    "#39": "'",
  }
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16))
    }
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10))
    return named[entity] ?? match
  })
}

export function htmlToText(html: string): string {
  const cleaned = stripScriptsAndStyles(html)
  const withBreaks = cleaned
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
  const stripped = withBreaks.replace(/<[^>]+>/g, "")
  return collapseBlankLines(decodeEntities(stripped)).trim()
}

export function htmlToMarkdown(html: string): string {
  let text = stripScriptsAndStyles(html)
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => {
    const hashes = "#".repeat(Number(level))
    return `\n\n${hashes} ${inlineText(inner)}\n\n`
  })
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => `\n- ${inlineText(inner)}`)
  text = text.replace(/<(pre|code)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, ""))
    return code.includes("\n") ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : ` \`${code}\` `
  })
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = inlineText(inner)
    return label.length > 0 ? `[${label}](${href})` : href
  })
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `**${inlineText(inner)}**`)
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t: string, inner: string) => `*${inlineText(inner)}*`)
  text = text.replace(/<\/(p|div|section|article|header|footer|ul|ol|tr|blockquote)>/gi, "\n\n")
  text = text.replace(/<br\s*\/?>/gi, "\n")
  text = text.replace(/<[^>]+>/g, "")
  return collapseBlankLines(decodeEntities(text)).trim()
}

function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

function collapseBlankLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}
