import { z } from "zod"
import { ZCodeError } from "@/util/errors"
import { globalConfigFile, projectConfigFile } from "@/config/paths"

export const PermissionModeSchema = z.enum(["allow", "ask", "deny"])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

const ModelPricingSchema = z.object({
  input: z.number(),
  cachedInput: z.number(),
  output: z.number(),
})
export type ModelPricing = z.infer<typeof ModelPricingSchema>

const ModelInfoSchema = z.object({
  context: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  pricing: ModelPricingSchema.optional(),
})
export type ModelInfo = z.infer<typeof ModelInfoSchema>

export const DEFAULT_MODELS: Record<string, ModelInfo> = {
  "glm-5.2": {
    context: 200_000,
    maxOutput: 128_000,
    pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 },
  },
  "glm-5.2[1m]": {
    context: 1_000_000,
    maxOutput: 128_000,
    pricing: { input: 1.4, cachedInput: 0.26, output: 4.4 },
  },
  "glm-5.1": { context: 200_000, maxOutput: 128_000 },
  "glm-4.7": { context: 200_000, maxOutput: 128_000 },
}

const McpStdioServerSchema = z.object({
  type: z.literal("stdio").default("stdio"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Hide this server's tools behind `toolsearch` until the model activates them. */
  defer: z.boolean().default(false),
})

const McpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  /** Hide this server's tools behind `toolsearch` until the model activates them. */
  defer: z.boolean().default(false),
})

export const McpServerSchema = z.union([McpStdioServerSchema, McpHttpServerSchema])
export type McpServerConfig = z.infer<typeof McpServerSchema>

const AutonomySchema = z.object({
  goalMaxEvaluations: z.number().int().positive().default(25),
  loopMaxTicks: z.number().int().positive().default(100),
})

const BudgetSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  warnAt: z.number().min(0.1).max(1).default(0.8),
})

export const ConfigSchema = z.object({
  provider: z.enum(["zai", "bigmodel"]).default("zai"),
  model: z.string().default("glm-5.2"),
  endpointKind: z.enum(["coding", "general"]).default("coding"),
  apiKeyEnv: z.record(z.string(), z.string()).default({}),
  models: z.record(z.string(), ModelInfoSchema).default(DEFAULT_MODELS),
  reasoningEffort: z.enum(["high", "max"]).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  permissions: z.record(z.string(), PermissionModeSchema).default({}),
  bashRules: z.record(z.string(), PermissionModeSchema).default({}),
  mcp: z
    .object({ servers: z.record(z.string(), McpServerSchema).default({}) })
    .default({ servers: {} }),
  compaction: z
    .object({ threshold: z.number().min(0.1).max(1).default(0.8) })
    .default({ threshold: 0.8 }),
  compression: z
    .object({
      enabled: z.boolean().default(true),
      keepRecentResults: z.number().int().min(1).default(3),
      idleMs: z.number().int().positive().default(300_000),
    })
    .default({ enabled: true, keepRecentResults: 3, idleMs: 300_000 }),
  spill: z
    .object({
      enabled: z.boolean().default(true),
      thresholdBytes: z.number().int().positive().default(30_720),
      previewLines: z.number().int().positive().default(200),
    })
    .default({ enabled: true, thresholdBytes: 30_720, previewLines: 200 }),
  budget: BudgetSchema.default({ warnAt: 0.8 }),
  autonomy: AutonomySchema.default({ goalMaxEvaluations: 25, loopMaxTicks: 100 }),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      sessionBudgetBytes: z.number().int().positive().default(61_440),
    })
    .default({ enabled: true, sessionBudgetBytes: 61_440 }),
  skills: z
    .object({
      paths: z.array(z.string()).default([]),
      disabled: z.array(z.string()).default([]),
      bundled: z.boolean().default(true),
      interop: z
        .object({
          claude: z.boolean().default(true),
          agents: z.boolean().default(true),
        })
        .default({ claude: true, agents: true }),
      catalogBudgetChars: z.number().int().positive().default(4000),
    })
    .default({
      paths: [],
      disabled: [],
      bundled: true,
      interop: { claude: true, agents: true },
      catalogBudgetChars: 4000,
    }),
})

export type Config = z.infer<typeof ConfigSchema>

export interface ResolvedConfig extends Config {
  cwd: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value)
    } else {
      out[key] = value
    }
  }
  return out
}

async function readConfigFile(file: string): Promise<Record<string, unknown>> {
  const handle = Bun.file(file)
  if (!(await handle.exists())) return {}
  let text: string
  try {
    text = await handle.text()
  } catch (error) {
    throw new ZCodeError("config", `cannot read ${file}: ${String(error)}`)
  }
  if (text.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ZCodeError("config", `${file} is not valid JSON: ${String(error)}`)
  }
  if (!isPlainObject(parsed)) throw new ZCodeError("config", `${file} must contain a JSON object`)
  return parsed
}

export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  const globalRaw = await readConfigFile(globalConfigFile())
  const projectRaw = await readConfigFile(projectConfigFile(cwd))
  const merged = deepMerge(globalRaw, projectRaw)
  const result = ConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    throw new ZCodeError("config", `invalid configuration: ${issues}`)
  }
  return { ...result.data, cwd }
}

export function modelInfo(config: ResolvedConfig, model: string): ModelInfo | undefined {
  return config.models[model]
}
