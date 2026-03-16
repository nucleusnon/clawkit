#!/usr/bin/env node
import { basename } from 'node:path';
import { Command } from 'commander';
import { runCreateCommand } from './commands/create.js';
import { runDevCommand } from './commands/dev.js';

const VERSION = '0.1.0';
const executableName = basename(process.argv[1] ?? 'clawkit');

const program = new Command();
program
  .name(executableName)
  .description('ClawKit CLI - a Next.js-like framework for AI agents')
  .version(VERSION);

program
  .command('create')
  .description('Scaffold a new ClawKit agent project')
  .argument('<project-name>', 'Project folder name')
  .option('-f, --force', 'Overwrite scaffold files in a non-empty folder')
  .option('--verbose', 'Enable verbose output')
  .action(async (projectName: string, options: { force?: boolean; verbose?: boolean }) => {
    await runCreateCommand(projectName, options);
  });

program
  .command('dev')
  .description('Run the local agent runtime with hot reload')
  .option('-c, --config <path>', 'Path to agent config', 'agent.ts')
  .option('-q, --query <text>', 'Run a single query and exit')
  .option('--verbose', 'Enable verbose output')
  .action(async (options: { config?: string; query?: string; verbose?: boolean }) => {
    await runDevCommand(options);
  });

const rawArgs = process.argv.slice(2);
const knownCommands = new Set(['create', 'dev', 'help']);
const args = [...rawArgs];

if (args.length > 0 && !args[0].startsWith('-') && !knownCommands.has(args[0])) {
  args.unshift('create');
}

if (args.length === 0) {
  program.help();
}

program.parseAsync(['node', executableName, ...args]).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
