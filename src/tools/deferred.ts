import type { ResolvedConfig } from "@/config/config"
import type { LLMToolDecl } from "@/llm/types"
import type { AnyTool, ToolRegistry } from "@/tools/registry"

export const TOOL_SEARCH_NAME = "toolsearch"
const MCP_PREFIX = "mcp__"

/** Deferred tools the model has activated. Runtime-scoped, so children start with nothing. */
export class DeferredState {
  private readonly names = new Set<string>()

  get activated(): ReadonlySet<string> {
    return this.names
  }

  /** Additive only: activation never reverses, so a schema stays visible once it has been sent. */
  activate(names: readonly string[]): void {
    for (const name of names) this.names.add(name)
  }
}

/**
 * Activation state for a child agent. A child's toolset is curated up front — every tool in it was
 * named explicitly by a grant — so its deferred tools start activated rather than hidden. Deferral
 * exists to keep a large server's schemas out of the prompt, which a handful of named tools do not
 * threaten; leaving them hidden would instead cost a discovery turn, or strand the child entirely
 * when its toolset has no `toolsearch` to discover them with.
 */
export function childDeferredState(toolNames: Iterable<string>, config: ResolvedConfig): DeferredState {
  const state = new DeferredState()
  state.activate([...toolNames].filter((name) => isDeferredTool(name, config)))
  return state
}

/** True when `name` belongs to a configured MCP server that opted into `defer`. */
export function isDeferredTool(name: string, config: ResolvedConfig): boolean {
  if (!name.startsWith(MCP_PREFIX)) return false
  for (const [server, settings] of Object.entries(config.mcp.servers)) {
    if (settings.defer && name.startsWith(`${MCP_PREFIX}${server}__`)) return true
  }
  return false
}

/** Deferred tools still hidden from the model. */
export function pendingDeferredTools(registry: ToolRegistry, config: ResolvedConfig, state: DeferredState): AnyTool[] {
  return registry.list().filter((tool) => isDeferredTool(tool.name, config) && !state.activated.has(tool.name))
}

/** Case-insensitive substring match over the name and description of the pending set. */
export function searchPendingDeferred(
  registry: ToolRegistry,
  config: ResolvedConfig,
  state: DeferredState,
  query: string,
): AnyTool[] {
  const term = query.trim().toLowerCase()
  if (term.length === 0) return []
  return pendingDeferredTools(registry, config, state).filter(
    (tool) => tool.name.toLowerCase().includes(term) || tool.description.toLowerCase().includes(term),
  )
}

/**
 * The tool list for one request. A hidden deferred tool contributes only its name, and only inside
 * the search tool's description — never the system prompt or a message, so the request prefix stays
 * byte-stable. With nothing deferred the search tool is dropped entirely, so the default
 * configuration carries no overhead at all.
 */
export function projectDeclarations(
  registry: ToolRegistry,
  config: ResolvedConfig,
  state: DeferredState,
): LLMToolDecl[] {
  const pending = pendingDeferredTools(registry, config, state)
  const hidden = new Set(pending.map((tool) => tool.name))
  const declarations = registry.declarations().filter((decl) => !hidden.has(decl.name))
  if (pending.length === 0) return declarations.filter((decl) => decl.name !== TOOL_SEARCH_NAME)

  const names = pending.map((tool) => tool.name).join(", ")
  return declarations.map((decl) =>
    decl.name === TOOL_SEARCH_NAME
      ? { ...decl, description: `${decl.description}\n\nDeferred tools you can activate: ${names}` }
      : decl,
  )
}
