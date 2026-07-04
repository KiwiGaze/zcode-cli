export type ToolResultStatus = "ok" | "error" | "denied" | "aborted"

export interface ToolResult {
  status: ToolResultStatus
  /** Text fed back to the model as the tool output. */
  output: string
  /** One-line summary shown in the UI tool card. */
  title?: string
  metadata?: Record<string, unknown>
}

export function okResult(output: string, title?: string, metadata?: Record<string, unknown>): ToolResult {
  return { status: "ok", output, ...(title === undefined ? {} : { title }), ...(metadata === undefined ? {} : { metadata }) }
}

export function errorResult(output: string, title?: string): ToolResult {
  return { status: "error", output, ...(title === undefined ? {} : { title }) }
}
