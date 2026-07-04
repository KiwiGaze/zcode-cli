#!/usr/bin/env bun
import { Command } from "commander"
import { startRepl } from "@/ui/repl"
import { ZCodeError } from "@/util/errors"

const program = new Command()

program
  .name("zcode-cli")
  .description("Terminal coding agent for GLM models (z.ai / bigmodel.cn)")
  .version("0.1.0")
  .option("-m, --model <model>", "model id (overrides config)")
  .option("-p, --provider <provider>", "provider: zai | bigmodel")
  .action(async (options: { model?: string; provider?: string }) => {
    await startRepl({
      cwd: process.cwd(),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    })
  })

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof ZCodeError) {
    process.stderr.write(`zcode: ${error.message}\n`)
    process.exit(1)
  }
  throw error
})
