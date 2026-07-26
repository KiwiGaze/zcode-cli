import type { TokenUsage } from "@/session/messages"
import type { ToolResult } from "@/tools/types"
import type { PermissionDecision, PermissionRequest } from "@/permissions/types"
import type { TodoItem } from "@/tools/todo-state"
import type { AutonomyStatus } from "@/ui/autonomy"

export type RenderedPart =
  { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool"; callId: string }

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

export type ActivityState =
  | { kind: "idle" }
  | { kind: "turn"; startedAt: number; lastModelActivityAt: number }
  | { kind: "compaction"; startedAt: number }

export type ContextStatus =
  | { kind: "measured"; tokens: number; window: number; compactAtRatio: number }
  | { kind: "estimated"; tokens: number; window: number; compactAtRatio: number }
  | { kind: "unknownAfterCompaction"; window: number; compactAtRatio: number }

export interface OperationCompletion {
  id: number
  kind: "turn" | "compaction"
  outcome: "completed" | "aborted" | "failed"
}

export interface StatusInfo {
  provider: string
  model: string
  usage: TokenUsage
  latestResponseUsage?: TokenUsage
  costUsd: number
  planMode: boolean
  autoMode: boolean
  context: ContextStatus
  /** Last projection-time compression pass, shown until the next one replaces it. */
  compressionNote?: string
  /** Present while a `/goal` pursuit or `/loop` run is driving turns. */
  autonomy?: AutonomyStatus
}

export interface ViewState {
  history: ViewItem[]
  live: LiveAssistant | null
  permission: PendingPermission | null
  activity: ActivityState
  completion: OperationCompletion | null
  queuedInputs: readonly { label: string }[]
  status: StatusInfo
  todos: TodoItem[]
}
