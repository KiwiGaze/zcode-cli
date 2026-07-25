import { query, type QueryDeps } from "@/agent/query"
import type { AgentEvent } from "@/agent/events"
import type { ResolvedConfig } from "@/config/config"
import type { AgentRuntime } from "@/agent/runtime"
import { compact, shouldCompact, contextWindow, lastPromptTokens } from "@/agent/compact"
import { estimateSessionCost } from "@/agent/budget"
import type { LiveAssistant, StatusInfo, ToolView, ViewItem, ViewState } from "@/ui/view"
import type { Session } from "@/session/session"
import { EMPTY_USAGE, assistantText, type ChatItem, type ModelUsage } from "@/session/messages"
import { recordUsage } from "@/session/session"
import type { SessionStore, LoadedSession } from "@/session/store"
import type { MemorySession } from "@/memory/recall"
import { createAutonomyDriver, type AutonomyDriver, type AutonomyDriverOptions } from "@/ui/autonomy"
import type { McpConnection } from "@/mcp/client"
import type { SlashCommand } from "@/commands/registry"
import { discoverSkills } from "@/skills/discover"
import { discoverAgents } from "@/subagents/discover"
import { isElevatingAgent } from "@/subagents/types"
import { setAgents } from "@/agent/runtime"
import { substituteArgs } from "@/skills/args"
import { newId } from "@/util/id"

const FLUSH_INTERVAL_MS = 40

type Listener = () => void

export interface ControllerOptions {
  session: Session
  config: ResolvedConfig
  runtime: AgentRuntime
  store?: SessionStore
  deps?: QueryDeps
  memory?: MemorySession
  autonomy?: AutonomyDriverOptions
  onExit?: () => void
}

export class AppController {
  private session: Session
  private config: ResolvedConfig
  private runtime: AgentRuntime
  private store: SessionStore | undefined
  private readonly deps: QueryDeps | undefined
  private readonly memory: MemorySession | undefined
  private readonly autonomyOptions: AutonomyDriverOptions | undefined
  private autonomy: AutonomyDriver | undefined
  private readonly onExit: (() => void) | undefined

  private history: ViewItem[] = []
  private live: LiveAssistant | null = null
  private busy = false
  private permission: ViewState["permission"] = null
  private abortController: AbortController | null = null
  private persistedCount = 0
  private persistQueue: Promise<void> = Promise.resolve()
  private mcpConnections: McpConnection[] = []
  private compressionNote: string | undefined

  private listeners = new Set<Listener>()
  private snapshot: ViewState
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(options: ControllerOptions) {
    this.session = options.session
    this.config = options.config
    this.runtime = options.runtime
    this.store = options.store
    this.deps = options.deps
    this.memory = options.memory
    this.autonomyOptions = options.autonomy
    this.onExit = options.onExit
    if (options.deps?.llm !== undefined && this.runtime.llm === undefined) this.runtime.llm = options.deps.llm
    this.persistedCount = this.session.items.length
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
    this.runtime.config = this.config
    this.runtime.permissions.setConfig(this.config)
    this.memory?.setConfig(this.config)
    this.addNotice(`switched to ${provider} · ${model}`)
  }

  setStore(store: SessionStore): void {
    this.store = store
    this.persistedCount = this.session.items.length
  }

  setMcpConnections(connections: McpConnection[]): void {
    this.mcpConnections = connections
  }

  mcpSummary(): string {
    if (this.mcpConnections.length === 0) return "no MCP servers configured"
    const lines = ["MCP servers:"]
    for (const connection of this.mcpConnections) {
      if (connection.status === "connected") {
        lines.push(`  ${connection.server}  connected (${connection.toolCount} tools)`)
      } else {
        lines.push(`  ${connection.server}  failed: ${connection.error ?? "unknown error"}`)
      }
    }
    return lines.join("\n")
  }

  /** User-invocable skills as slash commands, for dispatch and input completion. */
  skillCommands(): SlashCommand[] {
    return this.runtime.skills
      .filter((skill) => skill.userInvocable)
      .map((skill) => ({ name: skill.name, description: skill.description ?? "skill" }))
  }

  skillsSummary(): string {
    const skills = this.runtime.skills
    if (skills.length === 0) return "no skills discovered"
    const lines = ["skills:"]
    for (const skill of skills) {
      const flags: string[] = []
      if (skill.source === "bundled") flags.push("bundled")
      if (skill.context === "fork") flags.push("fork")
      if (skill.allowedTools !== undefined && skill.allowedTools.length > 0) flags.push("elevated")
      if (skill.disableModelInvocation) flags.push("no-model")
      if (!skill.userInvocable) flags.push("no-slash")
      const suffix = flags.length > 0 ? `  [${flags.join(", ")}]` : ""
      lines.push(`  ${skill.name}  ${skill.description ?? "(no description)"}${suffix}`)
    }
    return lines.join("\n")
  }

  agentsSummary(): string {
    const agents = this.runtime.agents
    if (agents.length === 0) return "no subagent types discovered"
    const lines = ["subagent types:"]
    for (const agent of agents) {
      const flags: string[] = []
      if (agent.source === "builtin") flags.push("builtin")
      if (isElevatingAgent(agent)) flags.push("elevated")
      if (agent.model !== undefined) flags.push(agent.model)
      const suffix = flags.length > 0 ? `  [${flags.join(", ")}]` : ""
      lines.push(`  ${agent.name}  ${agent.description}${suffix}`)
    }
    return lines.join("\n")
  }

  async reloadAgents(): Promise<void> {
    const discovered = await discoverAgents(this.config.cwd, this.config)
    setAgents(this.runtime, discovered.agents)
    this.addNotice(`subagent types reloaded (${discovered.agents.length})`)
    this.noteDiscoveryWarnings("agents", discovered.warnings)
  }

  async reloadSkills(): Promise<void> {
    const discovered = await discoverSkills(this.config.cwd, this.config)
    this.runtime.skills = discovered.skills
    this.addNotice(`skills reloaded (${discovered.skills.length})`)
    this.noteDiscoveryWarnings("skills", discovered.warnings)
  }

  /** The only thing a user sees when a definition is skipped: how many, and the first reason. */
  noteDiscoveryWarnings(kind: string, warnings: string[]): void {
    if (warnings.length === 0) return
    this.addNotice(`${kind}: skipped ${warnings.length} (${warnings[0]})`, "warn")
  }

  async runSkill(name: string, args: string): Promise<void> {
    const skill = this.runtime.skills.find((candidate) => candidate.name === name)
    if (skill === undefined) {
      this.addNotice(`no such skill: /${name}`, "warn")
      return
    }
    if (!skill.userInvocable) {
      this.addNotice(`skill ${name} is not user-invocable`, "warn")
      return
    }
    if (skill.allowedTools !== undefined && skill.allowedTools.length > 0) {
      this.runtime.permissions.grantSkillTools(skill.allowedTools)
    }
    const prompt = substituteArgs(skill.body, {
      raw: args,
      skillDir: skill.dir,
      sessionId: this.session.id,
      names: skill.arguments ?? [],
    })
    const label = `/${name}${args.length > 0 ? ` ${args}` : ""}`
    if (this.busy || this.autonomy?.status() !== undefined) {
      this.session.pendingInputs.push(prompt)
      this.addNotice(`queued ${label}`)
      return
    }
    this.history = [...this.history, { kind: "user", id: newId("view"), text: label }]
    await this.runTurn(prompt)
    await this.drainPendingInputs()
  }

  clear(): void {
    this.abort()
    this.session.items = []
    this.session.totalUsage = { ...EMPTY_USAGE }
    this.session.usageByModel = {}
    this.persistedCount = 0
    this.history = []
    this.live = null
    this.compressionNote = undefined
    this.commit()
  }

  toggleAutoMode(): boolean {
    const next = !this.runtime.permissions.isAutoMode()
    this.runtime.permissions.setAutoMode(next)
    this.addNotice(
      next ? "auto mode on — an LLM classifier approves actions; /auto to stop" : "auto mode off",
      next ? "warn" : "info",
    )
    return next
  }

  togglePlanMode(): boolean {
    const next = !this.runtime.permissions.isPlanMode()
    this.runtime.permissions.setPlanMode(next)
    this.addNotice(next ? "plan mode on — writes are blocked until you approve a plan" : "plan mode off")
    return next
  }

  session_(): Session {
    return this.session
  }

  recordModelUsage(modelUsage: ModelUsage): void {
    recordUsage(this.session, modelUsage.model, modelUsage.usage)
    this.persistModelUsage(modelUsage)
  }

  runtime_(): AgentRuntime {
    return this.runtime
  }

  private driver(): AutonomyDriver {
    this.autonomy ??= createAutonomyDriver(this, this.autonomyOptions)
    return this.autonomy
  }

  async runGoal(condition: string): Promise<void> {
    try {
      await this.driver().runGoal(condition)
    } finally {
      // The driver clears its status on the way out; the status line has to see that.
      this.commit()
    }
  }

  async runLoop(input: string): Promise<void> {
    try {
      await this.driver().runLoop(input)
    } finally {
      this.commit()
    }
  }

  /**
   * One driver-owned turn. A label pushes a user history entry (first tick only); retries and later
   * ticks stay out of the scrollback. Queued user input interleaves as an ordinary turn, exactly as
   * `submit` drains it, so a mid-pursuit message is judged like any other.
   */
  async runAutonomyTurn(prompt: string, label?: string): Promise<void> {
    if (label !== undefined) {
      this.history = [...this.history, { kind: "user", id: newId("view"), text: label }]
    }
    await this.runTurn(prompt)
    await this.drainPendingInputs()
  }

  loadFrom(loaded: LoadedSession, store?: SessionStore): void {
    this.abort()
    this.session = loaded.session
    this.config = { ...this.config, cwd: loaded.session.cwd }
    this.runtime.config = this.config
    this.runtime.permissions.setConfig(this.config)
    this.memory?.reset()
    this.runtime.compactions = loaded.compactions
    this.history = viewFromItems(loaded.session.items)
    this.live = null
    this.compressionNote = undefined
    this.store = store
    this.persistedCount = loaded.session.items.length
    this.commit()
  }

  exit(): void {
    this.abort()
    this.onExit?.()
  }

  abort(): void {
    this.autonomy?.stop()
    this.abortController?.abort()
  }

  isBusy(): boolean {
    return this.busy
  }

  async submit(prompt: string): Promise<void> {
    const trimmed = prompt.trim()
    if (trimmed.length === 0) return
    if (this.busy || this.autonomy?.status() !== undefined) {
      this.session.pendingInputs.push(trimmed)
      return
    }
    this.history = [...this.history, { kind: "user", id: newId("view"), text: trimmed }]
    await this.runTurn(trimmed)
    await this.drainPendingInputs()
  }

  private async drainPendingInputs(): Promise<void> {
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
    this.live = null
    this.commit()
    const deps = this.queryDeps()
    try {
      const stream = query({
        prompt,
        session: this.session,
        config: this.config,
        runtime: this.runtime,
        signal: this.abortController.signal,
        ...(deps === undefined ? {} : { deps }),
      })
      for await (const event of stream) {
        this.handleEvent(event)
      }
    } catch (error) {
      this.history = [
        ...this.history,
        { kind: "error", id: newId("view"), text: error instanceof Error ? error.message : String(error) },
      ]
    } finally {
      this.finishLive()
      await this.persist()
      await this.maybeCompact()
      this.busy = false
      this.abortController = null
      this.commit()
    }
  }

  private queryDeps(): QueryDeps | undefined {
    const store = this.store
    return {
      ...this.deps,
      ...(this.memory === undefined ? {} : { memory: this.memory }),
      persistUsage: (usage) => {
        if (store !== undefined) {
          void store.appendUsage({ type: "usage", ...usage }).catch(() => {})
        }
      },
    }
  }

  private persistModelUsage(modelUsage: ModelUsage): void {
    if (this.store === undefined) return
    void this.store.appendUsage({ type: "usage", ...modelUsage }).catch(() => {})
  }

  async compactNow(): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.commit()
    try {
      await this.runCompaction()
    } finally {
      this.busy = false
      this.commit()
    }
  }

  private async maybeCompact(): Promise<void> {
    if (this.abortController?.signal.aborted) return
    if (!shouldCompact(this.session, this.config, this.runtime.compactions)) return
    await this.runCompaction()
  }

  private async runCompaction(): Promise<void> {
    const signal = this.abortController?.signal ?? new AbortController().signal
    try {
      const record = await compact(this.session, this.config, this.runtime.compactions, signal, this.deps)
      if (record === null) {
        this.addNotice("nothing to compact yet", "warn")
        return
      }
      if (this.store !== undefined) await this.store.appendCompaction(record)
      this.history = [...this.history, { kind: "notice", id: newId("view"), tone: "info", text: "context compacted" }]
      this.commit()
    } catch (error) {
      this.addNotice(`compaction failed: ${error instanceof Error ? error.message : String(error)}`, "warn")
    }
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message-start":
        this.finishLive()
        this.live = { id: newId("view"), parts: [], tools: {} }
        this.commit()
        break
      case "text-delta":
        if (this.live !== null) {
          appendText(this.live, "text", event.delta)
          this.scheduleFlush()
        }
        break
      case "reasoning-delta":
        if (this.live !== null) {
          appendText(this.live, "reasoning", event.delta)
          this.scheduleFlush()
        }
        break
      case "tool-start":
        if (this.live !== null) {
          this.live.parts.push({ type: "tool", callId: event.callId })
          this.live.tools[event.callId] = {
            callId: event.callId,
            name: event.name,
            input: event.input,
            status: "pending",
            title: "",
            progress: "",
          }
          this.commit()
        }
        break
      case "tool-progress": {
        const tool = this.live?.tools[event.callId]
        if (tool !== undefined) {
          tool.progress += event.chunk
          this.scheduleFlush()
        }
        break
      }
      case "tool-end": {
        const tool = this.live?.tools[event.callId]
        if (tool !== undefined) {
          tool.status = event.result.status
          tool.result = event.result
          if (event.result.title !== undefined) tool.title = event.result.title
        }
        void this.persist()
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
        this.history = [...this.history, { kind: "notice", id: newId("view"), tone: "info", text: "context compacted" }]
        this.commit()
        break
      case "compression":
        this.compressionNote = describeCompression(event)
        this.commit()
        break
      case "memory-recall":
        this.addNotice(`memory: recalled ${event.names.length} — ${event.names.join(", ")}`)
        break
      case "budget-warning":
      case "budget-exceeded":
        this.addNotice(event.reason, "warn")
        break
      case "auto-verdict":
        // A silent approval is the point of the mode; the tool card and the audit record carry it.
        if (event.verdict === "block") this.addNotice(`auto mode blocked ${event.tool}: ${event.reason}`, "warn")
        if (event.verdict === "unavailable") {
          this.addNotice("auto mode classifier unavailable — asking you directly", "warn")
        }
        void this.recordVerdict(event)
        break
      case "auto-handoff":
        this.addNotice(event.reason, "warn")
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

  /** Auto mode is a security feature, so every verdict is reconstructable after the fact. */
  private async recordVerdict(event: Extract<AgentEvent, { type: "auto-verdict" }>): Promise<void> {
    if (this.store === undefined) return
    try {
      await this.store.appendAutoVerdict({
        type: "auto-verdict",
        ts: Date.now(),
        callId: event.callId,
        tool: event.tool,
        subject: event.subject,
        stage: event.stage,
        verdict: event.verdict,
        reason: event.reason,
        model: event.model,
      })
    } catch {
      // persistence failure is non-fatal for the running session
    }
  }

  /**
   * Append items the store has not seen yet. Calls serialize, so awaiting one also waits for the
   * appends an earlier unawaited call is still writing — including items it claimed after starting.
   */
  private persist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(() => this.appendPending())
    return this.persistQueue
  }

  private async appendPending(): Promise<void> {
    if (this.store === undefined) return
    const items = this.session.items
    while (this.persistedCount < items.length) {
      const item = items[this.persistedCount]
      this.persistedCount += 1
      if (item !== undefined) {
        try {
          await this.store.appendItem(item)
        } catch {
          // persistence failure is non-fatal for the running session
        }
      }
    }
  }

  private finishLive(): void {
    if (this.live === null) return
    const live = this.live
    if (live.parts.length > 0) {
      this.history = [...this.history, { kind: "assistant", id: live.id, parts: live.parts, tools: live.tools }]
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
    const window = contextWindow(this.config)
    const contextTokens = lastPromptTokens(this.session, this.runtime.compactions)
    const autonomy = this.autonomy?.status()
    const status: StatusInfo = {
      provider: this.config.provider,
      model: this.config.model,
      usage: this.session.totalUsage,
      costUsd: estimateSessionCost(this.config, this.session.usageByModel),
      planMode: this.runtime.permissions.isPlanMode(),
      autoMode: this.runtime.permissions.isAutoMode(),
      contextTokens,
      contextWindow: window,
      ...(this.compressionNote === undefined ? {} : { compressionNote: this.compressionNote }),
      ...(autonomy === undefined ? {} : { autonomy }),
    }
    return {
      history: this.history,
      live: this.live === null ? null : { ...this.live, parts: [...this.live.parts], tools: { ...this.live.tools } },
      permission: this.permission,
      status,
      busy: this.busy,
      todos: this.runtime.todos.list(),
    }
  }
}

function describeCompression(event: Extract<AgentEvent, { type: "compression" }>): string {
  const tiers: string[] = []
  if (event.budgeted > 0) tiers.push(`${event.budgeted} budgeted`)
  if (event.snipped > 0) tiers.push(`${event.snipped} snipped`)
  if (event.cleared > 0) tiers.push(`${event.cleared} cleared`)
  const saved = event.savedChars < 1000 ? `${event.savedChars}` : `${Math.round(event.savedChars / 1000)}k`
  return `−${saved} chars (${tiers.join(", ")})`
}

function appendText(live: LiveAssistant, type: "text" | "reasoning", text: string): void {
  const last = live.parts[live.parts.length - 1]
  if (last !== undefined && last.type === type) {
    last.text += text
    return
  }
  live.parts.push({ type, text })
}

function viewFromItems(items: ChatItem[]): ViewItem[] {
  const view: ViewItem[] = []
  const toolResults = new Map<string, ToolView>()
  for (const item of items) {
    if (item.type === "tool-result") {
      toolResults.set(item.callId, {
        callId: item.callId,
        name: item.name,
        input: undefined,
        status: item.result.status,
        title: item.result.title ?? "",
        progress: "",
        result: item.result,
      })
    }
  }
  for (const item of items) {
    if (item.type === "user") {
      view.push({ kind: "user", id: item.id, text: item.content.map((part) => part.text).join("") })
      continue
    }
    if (item.type === "assistant") {
      const tools: Record<string, ToolView> = {}
      const parts = item.parts.map((part) => {
        if (part.type === "tool-call") {
          const resolved = toolResults.get(part.callId)
          tools[part.callId] = resolved ?? {
            callId: part.callId,
            name: part.name,
            input: part.input,
            status: "ok",
            title: "",
            progress: "",
          }
          return { type: "tool" as const, callId: part.callId }
        }
        return { type: part.type, text: part.text }
      })
      if (assistantText(item).length > 0 || item.parts.some((part) => part.type === "tool-call")) {
        view.push({ kind: "assistant", id: item.id, parts, tools })
      }
    }
  }
  return view
}
