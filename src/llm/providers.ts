import type { ResolvedConfig } from "@/config/config"
import { ZCodeError } from "@/util/errors"

export type ProviderId = "zai" | "bigmodel"
export type EndpointKind = "coding" | "general"

export interface ProviderDef {
  name: string
  apiKeyEnv: string
  endpoints: Record<EndpointKind, string>
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  zai: {
    name: "Z.AI (International)",
    apiKeyEnv: "ZAI_API_KEY",
    endpoints: {
      general: "https://api.z.ai/api/paas/v4",
      coding: "https://api.z.ai/api/coding/paas/v4",
    },
  },
  bigmodel: {
    name: "智谱 BigModel (China)",
    apiKeyEnv: "BIGMODEL_API_KEY",
    endpoints: {
      general: "https://open.bigmodel.cn/api/paas/v4",
      coding: "https://open.bigmodel.cn/api/coding/paas/v4",
    },
  },
}

export const PROVIDER_IDS: ProviderId[] = ["zai", "bigmodel"]

export function apiKeyEnvName(provider: ProviderId, config: ResolvedConfig): string {
  return config.apiKeyEnv[provider] ?? PROVIDERS[provider].apiKeyEnv
}

export function resolveApiKey(provider: ProviderId, config: ResolvedConfig): string | undefined {
  const key = process.env[apiKeyEnvName(provider, config)]
  return key !== undefined && key.length > 0 ? key : undefined
}

export function requireApiKey(provider: ProviderId, config: ResolvedConfig): string {
  const key = resolveApiKey(provider, config)
  if (key === undefined) {
    throw new ZCodeError(
      "auth",
      `no API key for ${PROVIDERS[provider].name}: set ${apiKeyEnvName(provider, config)}`,
    )
  }
  return key
}

export function baseUrl(provider: ProviderId, kind: EndpointKind): string {
  return PROVIDERS[provider].endpoints[kind]
}
