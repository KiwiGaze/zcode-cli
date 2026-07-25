import { render } from "ink"
import { App } from "@/ui/App"
import { AppController } from "@/ui/controller"
import { createRuntime, setAgents } from "@/agent/runtime"
import { discoverInstructions } from "@/agent/instructions"
import { discoverSkills } from "@/skills/discover"
import { discoverAgents } from "@/subagents/discover"
import { loadConfig, type ResolvedConfig } from "@/config/config"
import { createSession } from "@/session/session"
import { SessionStore } from "@/session/store"
import { connectMcpServers } from "@/mcp/client"
import { createMemorySession } from "@/memory/recall"
import { memoryDir } from "@/config/paths"
import { resolveApiKey, PROVIDERS, type ProviderId } from "@/llm/providers"
import { ZCodeError } from "@/util/errors"

export interface ReplOptions {
  cwd: string
  model?: string
  provider?: string
}

export async function startRepl(options: ReplOptions): Promise<void> {
  let config = await loadConfig(options.cwd)
  config = applyOverrides(config, options)
  assertApiKey(config)

  const session = createSession(options.cwd)
  const runtime = createRuntime(config)
  runtime.permissions.setAutoMode(config.autoMode.enabled)
  runtime.instructions = await discoverInstructions(options.cwd)
  const discoveredSkills = await discoverSkills(options.cwd, config)
  runtime.skills = discoveredSkills.skills
  const discoveredAgents = await discoverAgents(options.cwd, config)
  setAgents(runtime, discoveredAgents.agents)
  const memory = config.memory.enabled ? createMemorySession({ config, dir: memoryDir(config.cwd) }) : undefined

  let store: SessionStore | undefined
  try {
    store = await SessionStore.open(session)
  } catch {
    store = undefined
  }

  const controller = new AppController({
    session,
    config,
    runtime,
    ...(store === undefined ? {} : { store }),
    ...(memory === undefined ? {} : { memory }),
  })

  if (discoveredSkills.warnings.length > 0) {
    controller.addNotice(
      `skills: skipped ${discoveredSkills.warnings.length} (${discoveredSkills.warnings[0]})`,
      "warn",
    )
  }

  if (discoveredAgents.warnings.length > 0) {
    controller.addNotice(
      `agents: skipped ${discoveredAgents.warnings.length} (${discoveredAgents.warnings[0]})`,
      "warn",
    )
  }

  const servers = config.mcp.servers
  if (Object.keys(servers).length > 0) {
    const { tools, connections } = await connectMcpServers(servers)
    for (const tool of tools) runtime.registry.register(tool)
    controller.setMcpConnections(connections)
    const failed = connections.filter((connection) => connection.status === "failed")
    if (failed.length > 0) {
      controller.addNotice(`MCP: ${failed.map((connection) => connection.server).join(", ")} failed to connect`, "warn")
    }
  }

  const instance = render(<App controller={controller} />)
  await instance.waitUntilExit()
}

function applyOverrides(config: ResolvedConfig, options: ReplOptions): ResolvedConfig {
  const next = { ...config }
  if (options.provider !== undefined) {
    if (options.provider !== "zai" && options.provider !== "bigmodel") {
      throw new ZCodeError("config", `unknown provider: ${options.provider}`)
    }
    next.provider = options.provider
  }
  if (options.model !== undefined) next.model = options.model
  return next
}

function assertApiKey(config: ResolvedConfig): void {
  const provider = config.provider as ProviderId
  if (resolveApiKey(provider, config) === undefined) {
    const envName = PROVIDERS[provider].apiKeyEnv
    throw new ZCodeError("auth", `no API key for ${PROVIDERS[provider].name}. Set ${envName} and try again.`)
  }
}
