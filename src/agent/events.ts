import type { AssistantMessage, TokenUsage } from "@/session/messages"
import type { ToolResult } from "@/tools/types"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"
import type { AgentError } from "@/util/errors"

export type AgentEvent =
  | { type: "message-start"; role: "assistant"; messageId: string }
  | { type: "text-delta"; messageId: string; delta: string }
  | { type: "reasoning-delta"; messageId: string; delta: string }
  | { type: "tool-start"; callId: string; name: string; input: unknown }
  | { type: "tool-progress"; callId: string; chunk: string }
  | { type: "tool-end"; callId: string; result: ToolResult }
  | { type: "permission-ask"; request: PermissionRequest; respond: (decision: PermissionDecision) => void }
  | { type: "step-usage"; usage: TokenUsage }
  | { type: "compaction"; summary: string }
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: AgentError }
