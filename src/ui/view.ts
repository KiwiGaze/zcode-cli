import type { TokenUsage } from "@/session/messages"
import type { ToolResult } from "@/tools/types"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"
import type { TodoItem } from "@/tools/todo-state"
import type { AutonomyStatus } from "@/ui/autonomy"

export type RenderedPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; callId: string }

export interface ToolView {
  callId: string
  name: string
  input: unknown
  status: "pending" | "ok" | "error" | "denied" | "aborted"
  title: string
  progress: string
  result?: ToolResult
}

export type ViewItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; parts: RenderedPart[]; tools: Record<string, ToolView> }
  | { kind: "notice"; id: string; tone: "info" | "warn"; text: string }
  | { kind: "error"; id: string; text: string }

export interface LiveAssistant {
  id: string
  parts: RenderedPart[]
  tools: Record<string, ToolView>
}

export interface PendingPermission {
  request: PermissionRequest
  respond: (decision: PermissionDecision) => void
}

export interface StatusInfo {
  provider: string
  model: string
  usage: TokenUsage
  costUsd: number
  planMode: boolean
  contextTokens: number
  contextWindow: number
  /** Last projection-time compression pass, shown until the next one replaces it. */
  compressionNote?: string
  /** Present while a `/goal` pursuit or `/loop` run is driving turns. */
  autonomy?: AutonomyStatus
}

export interface ViewState {
  history: ViewItem[]
  live: LiveAssistant | null
  permission: PendingPermission | null
  status: StatusInfo
  busy: boolean
  todos: TodoItem[]
}
