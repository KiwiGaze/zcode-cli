# ZCode CLI

A single-process terminal coding agent for GLM models, supporting the two Zhipu platforms:

- **z.ai** (international) — `ZAI_API_KEY`
- **bigmodel.cn** (China) — `BIGMODEL_API_KEY`

> **Disclaimer**: ZCode CLI is an independent open-source project. It is **not** an official
> z.ai / Zhipu product and is unaffiliated with the ZCode harness at zcode.z.ai.

## Quick start

```sh
bun install
export ZAI_API_KEY=sk-...   # or BIGMODEL_API_KEY
bun run dev
```

## Configuration

Global `~/.config/zcode/config.json`, overridden per-project by `.zcode.json`:

```jsonc
{
  "provider": "zai",            // zai | bigmodel
  "model": "glm-5.2",
  "endpointKind": "coding",     // coding (Coding Plan keys) | general (pay-as-you-go keys)
  "permissions": { "bash": "ask", "edit": "ask", "webfetch": "allow" },
  "bashRules": { "git status": "allow", "rm *": "ask" },
  "mcp": { "servers": {} },
  "compaction": { "threshold": 0.8 }
}
```

## Development

```sh
bun run typecheck   # tsc --noEmit
bun test            # unit + loop tests (mocked LLM)
bun run check       # typecheck + import-boundary + tests
```

Portions of this project are ported from [opencode](https://github.com/sst/opencode) (MIT).
See [NOTICE](./NOTICE) for file-level attribution.
