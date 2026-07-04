import { render } from "ink"
import { App } from "@/ui/App"
import { AppController } from "@/ui/controller"
import { loadConfig, type ResolvedConfig } from "@/config/config"
import { createSession } from "@/session/session"
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
  const controller = new AppController({ session, config })

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
    throw new ZCodeError(
      "auth",
      `no API key for ${PROVIDERS[provider].name}. Set ${envName} and try again.`,
    )
  }
}
