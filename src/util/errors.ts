export type AgentErrorCode =
  | "auth"
  | "api"
  | "rate-limit"
  | "aborted"
  | "config"
  | "tool"
  | "mcp"
  | "internal"

export interface AgentError {
  code: AgentErrorCode
  message: string
  retryable: boolean
}

export class ZCodeError extends Error {
  readonly code: AgentErrorCode
  readonly retryable: boolean

  constructor(code: AgentErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "ZCodeError"
    this.code = code
    this.retryable = options?.retryable ?? false
  }

  toAgentError(): AgentError {
    return { code: this.code, message: this.message, retryable: this.retryable }
  }
}

export function toZCodeError(value: unknown, fallbackCode: AgentErrorCode = "internal"): ZCodeError {
  if (value instanceof ZCodeError) return value
  if (value instanceof Error) {
    if (value.name === "AbortError") return new ZCodeError("aborted", "interrupted")
    return new ZCodeError(fallbackCode, value.message, { cause: value })
  }
  return new ZCodeError(fallbackCode, String(value))
}
