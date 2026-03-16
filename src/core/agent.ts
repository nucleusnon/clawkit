import { resolve } from 'node:path';
import { VectorMemory } from './memory.js';
import { AuditLogger } from '../security/audit.js';
import { SearchResponse, WebSearchTool } from '../tools/search.js';

export interface AgentConfig {
  name: string;
  instructions: string;
  memory?: {
    dbPath?: string;
    dimensions?: number;
  };
  search?: {
    enabled?: boolean;
    graylistPath?: string;
    allowGray?: boolean;
    maxResults?: number;
  };
}

export interface AgentRuntimeOptions {
  projectRoot?: string;
  verbose?: boolean;
  audit?: AuditLogger;
}

export class AgentRuntime {
  private readonly projectRoot: string;
  private readonly verbose: boolean;
  private readonly audit: AuditLogger;
  private readonly memory: VectorMemory;
  private readonly searchTool: WebSearchTool | null;
  private readonly config: AgentConfig;

  constructor(config: AgentConfig, options: AgentRuntimeOptions = {}) {
    this.config = validateConfig(config);
    this.projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.verbose = options.verbose ?? false;

    this.audit =
      options.audit ??
      new AuditLogger({
        logFilePath: resolve(this.projectRoot, 'logs/audit.jsonl'),
        verbose: this.verbose,
      });

    this.memory = new VectorMemory({
      dbPath: resolve(this.projectRoot, this.config.memory?.dbPath ?? 'memory/memory.db'),
      dimensions: this.config.memory?.dimensions ?? 128,
      audit: this.audit,
      verbose: this.verbose,
    });

    if (this.config.search?.enabled === false) {
      this.searchTool = null;
    } else {
      this.searchTool = new WebSearchTool({
        graylistPath: this.config.search?.graylistPath
          ? resolve(this.projectRoot, this.config.search.graylistPath)
          : undefined,
        allowGray: this.config.search?.allowGray ?? true,
        audit: this.audit,
        verbose: this.verbose,
      });
    }

    this.audit.info('agent.start', 'Agent runtime started', {
      name: this.config.name,
      searchEnabled: this.searchTool !== null,
    });
  }

  getAgentName(): string {
    return this.config.name;
  }

  getInstructions(): string {
    return this.config.instructions;
  }

  async handleInput(rawInput: string): Promise<string> {
    const input = rawInput.trim();
    if (!input) {
      return 'Input is empty. Type text or /help.';
    }

    this.audit.info('agent.input', 'Received user input', {
      chars: input.length,
    });

    if (input === '/help') {
      return [
        'Commands:',
        '- /search <query> : run web search with graylist security',
        '- /remember <text> : store text in local vector memory',
        '- /recall <query> : search local memory',
        '- /help : show commands',
        '- /exit : exit dev shell',
      ].join('\n');
    }

    if (input === '/exit') {
      return 'Use Ctrl+C or type "exit" in the dev shell to quit.';
    }

    if (input.startsWith('/search ')) {
      return this.handleSearchCommand(input.slice('/search '.length));
    }

    if (input.startsWith('/remember ')) {
      const payload = input.slice('/remember '.length).trim();
      if (!payload) {
        return 'Provide content after /remember.';
      }

      const record = this.memory.add(payload, { source: 'manual', type: 'note' });
      return `Stored memory #${record.id}.`;
    }

    if (input.startsWith('/recall ')) {
      const query = input.slice('/recall '.length).trim();
      if (!query) {
        return 'Provide a search query after /recall.';
      }

      return this.formatRecall(query);
    }

    this.memory.add(input, { source: 'user', type: 'input' });
    const related = this.memory.search(input, 3);

    const lines = [`${this.config.name}: ${this.config.instructions}`, `You said: ${input}`];

    if (related.length > 0) {
      lines.push('Related memory:');
      for (const entry of related) {
        lines.push(`- [${entry.score ?? 0}] ${entry.content}`);
      }
    }

    lines.push('Tip: use /search <query> to browse the web with graylist checks.');
    return lines.join('\n');
  }

  close(): void {
    this.memory.close();
    this.audit.info('agent.stop', 'Agent runtime stopped', { name: this.config.name });
  }

  private async handleSearchCommand(query: string): Promise<string> {
    const normalized = query.trim();
    if (!normalized) {
      return 'Provide a query after /search.';
    }

    if (!this.searchTool) {
      return 'Search is disabled in agent.ts.';
    }

    const response = await this.searchTool.search(normalized, {
      limit: this.config.search?.maxResults ?? 5,
    });

    this.memory.add(`search:${normalized}`, {
      source: 'search',
      query: normalized,
      resultCount: response.results.length,
    });

    return formatSearchResponse(response);
  }

  private formatRecall(query: string): string {
    const recalled = this.memory.search(query, 5);
    if (recalled.length === 0) {
      return `No memory found for '${query}'.`;
    }

    const lines = [`Memory matches for '${query}':`];
    for (const item of recalled) {
      lines.push(`- [${item.score ?? 0}] ${item.content}`);
    }

    return lines.join('\n');
  }
}

function formatSearchResponse(response: SearchResponse): string {
  if (response.results.length === 0) {
    const blockedInfo =
      response.blocked.length > 0
        ? ` (${response.blocked.length} blocked by graylist)`
        : '';
    return `No allowed results found${blockedInfo}.`;
  }

  const lines = [`Search results for '${response.query}':`];

  for (const result of response.results) {
    const tierLabel = result.tier === 'green' ? 'trusted' : 'flagged';
    lines.push(`- [${tierLabel}] ${result.title} -> ${result.url}`);
    if (result.snippet) {
      lines.push(`  ${result.snippet}`);
    }
  }

  if (response.blocked.length > 0) {
    lines.push(`Blocked results: ${response.blocked.length}`);
  }

  return lines.join('\n');
}

export function validateConfig(input: unknown): AgentConfig {
  if (!input || typeof input !== 'object') {
    throw new Error('Agent config must export an object as default.');
  }

  const candidate = input as Partial<AgentConfig>;

  if (!candidate.name || typeof candidate.name !== 'string') {
    throw new Error('agent.ts must define `name` as a string.');
  }

  if (!candidate.instructions || typeof candidate.instructions !== 'string') {
    throw new Error('agent.ts must define `instructions` as a string.');
  }

  const config: AgentConfig = {
    name: candidate.name.trim(),
    instructions: candidate.instructions.trim(),
    memory: {
      dbPath: candidate.memory?.dbPath ?? 'memory/memory.db',
      dimensions: candidate.memory?.dimensions ?? 128,
    },
    search: {
      enabled: candidate.search?.enabled ?? true,
      graylistPath: candidate.search?.graylistPath,
      allowGray: candidate.search?.allowGray ?? true,
      maxResults: candidate.search?.maxResults ?? 5,
    },
  };

  if (!config.name) {
    throw new Error('Agent name cannot be empty.');
  }

  if (!config.instructions) {
    throw new Error('Agent instructions cannot be empty.');
  }

  if (typeof config.memory?.dimensions !== 'number' || config.memory.dimensions <= 0) {
    throw new Error('memory.dimensions must be a positive number.');
  }

  if (
    typeof config.search?.maxResults !== 'number' ||
    Number.isNaN(config.search.maxResults) ||
    config.search.maxResults <= 0
  ) {
    throw new Error('search.maxResults must be a positive number.');
  }

  return config;
}
