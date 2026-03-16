import { randomUUID } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { AgentConfig, AgentRuntime, validateConfig } from '../core/agent.js';
import { AuditLogger } from '../security/audit.js';

export interface DevCommandOptions {
  config?: string;
  query?: string;
  verbose?: boolean;
}

export async function runDevCommand(options: DevCommandOptions = {}): Promise<void> {
  const projectRoot = process.cwd();
  const configPath = resolve(projectRoot, options.config ?? 'agent.ts');
  const cacheDir = resolve(projectRoot, '.clawkit-cache');
  const verbose = options.verbose ?? false;

  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  await mkdir(cacheDir, { recursive: true });

  const audit = new AuditLogger({
    logFilePath: resolve(projectRoot, 'logs/audit.jsonl'),
    verbose,
  });

  const runtimeOptions = {
    projectRoot,
    verbose,
    audit,
  };

  let runtime = new AgentRuntime(
    await loadAgentConfig(configPath, cacheDir, verbose, audit),
    runtimeOptions,
  );

  audit.info('dev.start', 'Started dev command', { configPath });

  let reloadTimeout: NodeJS.Timeout | undefined;
  const watcher = watch(configPath, () => {
    if (reloadTimeout) {
      clearTimeout(reloadTimeout);
    }

    reloadTimeout = setTimeout(() => {
      void reloadRuntime();
    }, 180);
  });

  const reloadRuntime = async (): Promise<void> => {
    try {
      const nextConfig = await loadAgentConfig(configPath, cacheDir, verbose, audit);
      const nextRuntime = new AgentRuntime(nextConfig, runtimeOptions);
      runtime.close();
      runtime = nextRuntime;

      audit.info('dev.reload.success', 'Hot reloaded agent config', {
        configPath,
        agentName: runtime.getAgentName(),
      });

      console.log(`\n[hot-reload] Config reloaded (${runtime.getAgentName()})`);
    } catch (error) {
      const message = serializeError(error);
      audit.error('dev.reload.failure', 'Hot reload failed', { error: message });
      console.error(`\n[hot-reload] Failed to reload config: ${message}`);
    }
  };

  if (options.query) {
    try {
      const response = await runtime.handleInput(options.query);
      console.log(response);
    } finally {
      watcher.close();
      runtime.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
    return;
  }

  const rl = createInterface({ input, output });

  console.log(`ClawKit dev running for '${runtime.getAgentName()}'`);
  console.log('Type /help for commands. Type exit to quit.\n');

  try {
    while (true) {
      const line = await rl.question('> ');
      const normalized = line.trim().toLowerCase();

      if (normalized === 'exit' || normalized === 'quit' || normalized === '/exit') {
        break;
      }

      try {
        const response = await runtime.handleInput(line);
        console.log(`${response}\n`);
      } catch (error) {
        const message = serializeError(error);
        audit.error('dev.input.error', 'Failed to handle input', { error: message });
        console.error(`Error: ${message}\n`);
      }
    }
  } finally {
    rl.close();
    watcher.close();
    runtime.close();
    await rm(cacheDir, { recursive: true, force: true });
    audit.info('dev.stop', 'Stopped dev command');
  }
}

async function loadAgentConfig(
  configPath: string,
  cacheDir: string,
  verbose: boolean,
  audit: AuditLogger,
): Promise<AgentConfig> {
  const compiledFilePath = resolve(cacheDir, `agent-config.${randomUUID()}.mjs`);

  await build({
    entryPoints: [configPath],
    outfile: compiledFilePath,
    bundle: false,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    sourcemap: 'inline',
    logLevel: verbose ? 'info' : 'silent',
  });

  try {
    const moduleUrl = `${pathToFileURL(compiledFilePath).href}?t=${Date.now()}`;
    const loadedModule = (await import(moduleUrl)) as Record<string, unknown>;
    const candidate = loadedModule.default ?? loadedModule.agent ?? loadedModule.config;
    const config = validateConfig(candidate);

    audit.info('dev.config.loaded', 'Loaded agent config', {
      configPath,
      agentName: config.name,
    });

    return config;
  } finally {
    await rm(compiledFilePath, { force: true });
  }
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
