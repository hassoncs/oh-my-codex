#!/usr/bin/env node

// oh-my-codex CLI entry point

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { rememberOmxLaunchContext } from '../utils/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, '..', '..');

rememberOmxLaunchContext();

const distEntry = join(root, 'dist', 'cli', 'index.js');
const sourceEntry = join(root, 'src', 'cli', 'index.ts');
const cliEntry = __dirname === join(root, 'src', 'cli') ? sourceEntry : distEntry;

if (existsSync(cliEntry)) {
  const { main } = await import(pathToFileURL(cliEntry).href);
  await main(process.argv.slice(2));
  if (process.argv[2] !== 'mcp-serve') {
    process.exit(process.exitCode ?? 0);
  }
} else {
  console.error('oh-my-codex: run "npm run build" first');
  process.exit(1);
}
