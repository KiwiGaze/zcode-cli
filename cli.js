#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url))),
);

const [cmd] = process.argv.slice(2);

function help() {
  console.log(
    [
      `zcode-cli ${pkg.version} — ZCode CLI agent for GLM models and the ZCode Desktop App`,
      '',
      'USAGE',
      '  zcode-cli <command> [options]',
      '',
      'COMMANDS',
      '  chat       Start an interactive agent session (coming soon)',
      '  --version  Print version',
      '  --help     Show this help',
      '',
      'This package name is reserved. The full CLI is under active development.',
    ].join('\n'),
  );
}

switch (cmd) {
  case '-v':
  case '--version':
    console.log(pkg.version);
    break;
  case undefined:
  case '-h':
  case '--help':
    help();
    break;
  default:
    console.error(`zcode-cli: unknown command '${cmd}'`);
    help();
    process.exitCode = 1;
}
