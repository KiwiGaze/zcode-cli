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
  "compaction": { "threshold": 0.8 },
  "compression": { "enabled": true, "keepRecentResults": 3, "idleMs": 300000 },
  "spill": { "enabled": true, "thresholdBytes": 30720, "previewLines": 200 },
  "ui": {
    "theme": "dark",
    "animations": true,
    "attention": "blurred",
    "terminalProgress": false
  }
}
```

`ui.theme` accepts `dark`, `light`, or `auto`; `ui.attention` accepts `always`, `blurred`, or `off`.
Set `ZCODE_NO_ANIM=1` to disable UI animation for one process without changing the config file.

### Context management

Four stages keep requests inside the model's window, cheapest first:

- **`spill`** — a tool result larger than `thresholdBytes` is written to
  `<data-dir>/projects/<project>/<session-id>/tool-results/<call-id>.txt` before it enters the
  session; the conversation keeps a `previewLines` preview plus the path, and the agent re-reads
  the file with the `read` tool when it needs the rest. Spill files are never deleted automatically.
- **`compression`** — free, per-request rewrites of tool-result output only: head+tail budgeting
  above 50% context use, snipping stale or superseded results above 60% (held off while the
  provider is still serving a cached prefix, until 75%), and clearing old results after `idleMs`
  of inactivity. `keepRecentResults` results always stay verbatim.
- **`compaction`** — the paid fallback: above `threshold` of the window, the model summarizes older
  turns. Keep it above the compression thresholds (the default 0.8 is); a lower value spends money
  on summarization before the free rewrites have finished their work.

Compression and spill only shape what is sent to the model. The session transcript on disk keeps
the pristine history either way, except for spilled output, which lives in its own file.

## Development

```sh
bun run typecheck   # tsc --noEmit
bun test            # unit + loop tests (mocked LLM)
bun run check       # typecheck + import-boundary + tests
```

Portions of this project are ported from [opencode](https://github.com/sst/opencode) (MIT).
See [NOTICE](./NOTICE) for file-level attribution.
