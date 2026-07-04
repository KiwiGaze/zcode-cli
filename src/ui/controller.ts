import { query, type QueryDeps } from "@/agent/query"
import type { AgentEvent } from "@/agent/events"
import type { ResolvedConfig } from "@/config/config"
import { estimateCost } from "@/ui/cost"
import type { LiveAssistant, StatusInfo, ViewItem, ViewState } from "@/ui/view"
import type { Session } from "@/session/session"
import { EMPTY_USAGE } from "@/session/messages"
import { newId } from "@/util/id"

const FLUSH_INTERVAL_MS = 40

type Listener = () => void

export interface ControllerOptions {
  session: Session
  config: ResolvedConfig
  deps?: QueryDeps
  onExit?: () => void
}

export class AppController {
  private session: Session
  private config: ResolvedConfig
  private readonly deps: QueryDeps | undefined
  private readonly onExit: (() => void) | undefined

  private history: ViewItem[] = []
  private live: LiveAssistant | null = null
  private busy = false
  private permission: ViewState["permission"] = null
  private abortController: AbortController | null = null

  private listeners = new Set<Listener>()
  private snapshot: ViewState
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(options: ControllerOptions) {
    this.session = options.session
    this.config = options.config
    this.deps = options.deps
    this.onExit = options.onExit
    this.snapshot = this.buildSnapshot()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ViewState => this.snapshot

  get config_(): ResolvedConfig {
    return this.config
  }

  addNotice(text: string, tone: "info" | "warn" = "info"): void {
    this.history = [...this.history, { kind: "notice", id: newId("view"), tone, text }]
    this.commit()
  }

  setModel(provider: ResolvedConfig["provider"], model: string): void {
    this.config = { ...this.config, provider, model }
    this.addNotice(`switched to ${provider} · ${model}`)
  }

  setConfig(config: ResolvedConfig): void {
    this.config = config
    this.commit()
  }

  clear(): void {
    this.session.items = []
    this.session.totalUsage = { ...EMPTY_USAGE }
    this.history = []
    this.live = null
    this.commit()
  }

  exit(): void {
    this.abort()
    this.onExit?.()
  }

  abort(): void {
    this.abortController?.abort()
  }

  isBusy(): boolean {
    return this.busy
  }

  async submit(prompt: string): Promise<void> {
    const trimmed = prompt.trim()
    if (trimmed.length === 0) return
    if (this.busy) {
      this.session.pendingInputs.push(trimmed)
      return
    }
    this.history = [...this.history, { kind: "user", id: newId("view"), text: trimmed }]
    await this.runTurn(trimmed)
    while (this.session.pendingInputs.length > 0) {
      const next = this.session.pendingInputs.shift()
      if (next === undefined) break
      this.history = [...this.history, { kind: "user", id: newId("view"), text: next }]
      await this.runTurn(next)
    }
  }

  private async runTurn(prompt: string): Promise<void> {
    this.busy = true
    this.abortController = new AbortController()
    this.live = { id: newId("view"), parts: [], tools: {} }
    this.commit()
    try {
      const stream = query({
        prompt,
        session: this.session,
        config: this.config,
        signal: this.abortController.signal,
        ...(this.deps === undefined ? {} : { deps: this.deps }),
      })
      for await (const event of stream) {
        this.handleEvent(event)
      }
    } finally {
      this.finishLive()
      this.busy = false
      this.abortController = null
      this.commit()
    }
  }

  private handleEvent(event: AgentEvent): void {
    const live = this.live
    if (live === null) return
    switch (event.type) {
      case "message-start":
        break
      case "text-delta":
        appendText(live, "text", event.delta)
        this.scheduleFlush()
        break
      case "reasoning-delta":
        appendText(live, "reasoning", event.delta)
        this.scheduleFlush()
        break
      case "tool-start":
        live.parts.push({ type: "tool", callId: event.callId })
        live.tools[event.callId] = {
          callId: event.callId,
          name: event.name,
          input: event.input,
          status: "pending",
          title: "",
          progress: "",
        }
        this.commit()
        break
      case "tool-progress": {
        const tool = live.tools[event.callId]
        if (tool !== undefined) {
          tool.progress += event.chunk
          this.scheduleFlush()
        }
        break
      }
      case "tool-end": {
        const tool = live.tools[event.callId]
        if (tool !== undefined) {
          tool.status = event.result.status
          tool.result = event.result
          if (event.result.title !== undefined) tool.title = event.result.title
        }
        this.commit()
        break
      }
      case "permission-ask":
        this.permission = { request: event.request, respond: event.respond }
        this.commit()
        break
      case "step-usage":
        this.commit()
        break
      case "compaction":
        this.history = [
          ...this.history,
          { kind: "notice", id: newId("view"), tone: "info", text: "context compacted" },
        ]
        this.commit()
        break
      case "done":
        break
      case "error":
        this.history = [...this.history, { kind: "error", id: newId("view"), text: event.error.message }]
        this.commit()
        break
    }
  }

  resolvePermission(decision: Parameters<NonNullable<ViewState["permission"]>["respond"]>[0]): void {
    const pending = this.permission
    if (pending === null) return
    this.permission = null
    pending.respond(decision)
    this.commit()
  }

  private finishLive(): void {
    if (this.live === null) return
    const live = this.live
    const hasContent = live.parts.length > 0
    if (hasContent) {
      this.history = [
        ...this.history,
        { kind: "assistant", id: live.id, parts: live.parts, tools: live.tools },
      ]
    }
    this.live = null
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.dirty) this.commit()
    }, FLUSH_INTERVAL_MS)
  }

  private commit(): void {
    this.dirty = false
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  private buildSnapshot(): ViewState {
    const status: StatusInfo = {
      provider: this.config.provider,
      model: this.config.model,
      usage: this.session.totalUsage,
      costUsd: estimateCost(this.config, this.config.model, this.session.totalUsage),
      planMode: false,
    }
    return {
      history: this.history,
      live: this.live === null ? null : { ...this.live, parts: [...this.live.parts], tools: { ...this.live.tools } },
      permission: this.permission,
      status,
      busy: this.busy,
    }
  }
}

function appendText(live: LiveAssistant, type: "text" | "reasoning", text: string): void {
  const last = live.parts[live.parts.length - 1]
  if (last !== undefined && last.type === type) {
    last.text += text
    return
  }
  live.parts.push({ type, text })
}
