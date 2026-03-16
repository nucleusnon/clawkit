import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLogger } from '../security/audit.js';

export type TrustTier = 'green' | 'gray' | 'red';

export interface Graylist {
  green: string[];
  gray: string[];
  red: string[];
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  tier: TrustTier;
  blocked: boolean;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  blocked: SearchResult[];
  totalParsed: number;
  flaggedCount: number;
}

export interface SearchToolOptions {
  graylistPath?: string;
  allowGray?: boolean;
  audit?: AuditLogger;
  verbose?: boolean;
  apiKey?: string;
}

export interface SearchOptions {
  limit?: number;
  allowGray?: boolean;
}

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

const DEFAULT_GRAYLIST: Graylist = {
  green: [
    'openai.com',
    'github.com',
    'nodejs.org',
    'developer.mozilla.org',
    'wikipedia.org',
    'npmjs.com',
  ],
  gray: ['reddit.com', 'medium.com', 'substack.com', 'quora.com'],
  red: ['example-malware.com', 'example-phishing.com', 'malware.test', 'phishing.test'],
};

const BRAVE_API_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export class WebSearchTool {
  private readonly allowGray: boolean;
  private readonly verbose: boolean;
  private readonly audit?: AuditLogger;
  private readonly apiKey: string;
  private readonly green: Set<string>;
  private readonly gray: Set<string>;
  private readonly red: Set<string>;

  constructor(options: SearchToolOptions = {}) {
    const graylist = loadGraylist(options.graylistPath);

    this.allowGray = options.allowGray ?? true;
    this.verbose = options.verbose ?? false;
    this.audit = options.audit;
    this.apiKey = options.apiKey ?? getBraveApiKey();
    this.green = new Set(graylist.green.map(normalizeDomain));
    this.gray = new Set(graylist.gray.map(normalizeDomain));
    this.red = new Set(graylist.red.map(normalizeDomain));

    this.audit?.info('search.graylist.loaded', 'Loaded graylist tiers', {
      green: this.green.size,
      gray: this.gray.size,
      red: this.red.size,
    });
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const normalized = query.trim();
    if (!normalized) {
      throw new Error('Search query cannot be empty.');
    }

    if (!this.apiKey) {
      throw new Error(
        'Brave API key required. Set BRAVE_API_KEY environment variable or pass apiKey option.'
      );
    }

    const limit = Math.max(1, options.limit ?? 5);
    const allowGray = options.allowGray ?? this.allowGray;

    const braveResults = await this.fetchBraveResults(normalized, limit * 2);
    const parsedResults = parseBraveResults(braveResults);

    const results: SearchResult[] = [];
    const blocked: SearchResult[] = [];

    for (const parsed of parsedResults) {
      if (results.length >= limit) {
        break;
      }

      const domain = extractDomain(parsed.url);
      if (!domain) {
        continue;
      }

      const tier = this.classifyDomain(domain);
      const item: SearchResult = {
        ...parsed,
        domain,
        tier,
        blocked: tier === 'red' || (tier === 'gray' && !allowGray),
      };

      if (item.blocked) {
        blocked.push(item);
        this.audit?.warn('search.result.blocked', 'Blocked search result by domain policy', {
          query: normalized,
          domain,
          tier,
          url: parsed.url,
        });
        continue;
      }

      if (tier === 'gray') {
        this.audit?.warn('search.result.flagged', 'Flagged gray-tier search result', {
          query: normalized,
          domain,
          url: parsed.url,
        });
      }

      results.push(item);
    }

    const response: SearchResponse = {
      query: normalized,
      results,
      blocked,
      totalParsed: parsedResults.length,
      flaggedCount: results.filter((item) => item.tier === 'gray').length,
    };

    this.audit?.info('search.completed', 'Web search completed', {
      query: normalized,
      resultCount: results.length,
      blockedCount: blocked.length,
      flaggedCount: response.flaggedCount,
      totalParsed: parsedResults.length,
    });

    if (this.verbose) {
      console.log(
        `Search '${normalized}': ${results.length} result(s), ${response.flaggedCount} flagged, ${blocked.length} blocked`
      );
    }

    return response;
  }

  private async fetchBraveResults(query: string, count: number): Promise<BraveSearchResponse> {
    const url = new URL(BRAVE_API_ENDPOINT);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(count, 20)));
    url.searchParams.set('offset', '0');

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Brave API error: HTTP ${response.status} - ${errorText}`);
    }

    return response.json() as Promise<BraveSearchResponse>;
  }

  private classifyDomain(domain: string): TrustTier {
    if (matchesDomain(domain, this.red)) {
      return 'red';
    }

    if (matchesDomain(domain, this.green)) {
      return 'green';
    }

    if (matchesDomain(domain, this.gray)) {
      return 'gray';
    }

    return 'gray';
  }
}

function parseBraveResults(response: BraveSearchResponse): Array<{ title: string; url: string; snippet: string }> {
  const results = response.web?.results ?? [];
  return results.map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.description ?? '',
  })).filter((r) => r.title && r.url);
}

function extractDomain(urlString: string): string {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matchesDomain(host: string, domains: Set<string>): boolean {
  for (const domain of domains) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      return true;
    }
  }

  return false;
}

function loadGraylist(customPath?: string): Graylist {
  const pathCandidates = [
    customPath ? resolve(customPath) : '',
    resolve(process.cwd(), 'src/security/graylist.json'),
    resolve(process.cwd(), 'security/graylist.json'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../security/graylist.json'),
  ].filter(Boolean);

  for (const candidate of pathCandidates) {
    try {
      if (!existsSync(candidate)) {
        continue;
      }

      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Graylist>;

      return {
        green: normalizeDomainList(parsed.green),
        gray: normalizeDomainList(parsed.gray),
        red: normalizeDomainList(parsed.red),
      };
    } catch {
      continue;
    }
  }

  return {
    green: [...DEFAULT_GRAYLIST.green],
    gray: [...DEFAULT_GRAYLIST.gray],
    red: [...DEFAULT_GRAYLIST.red],
  };
}

function normalizeDomainList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const values = input
    .map((entry) => (typeof entry === 'string' ? normalizeDomain(entry) : ''))
    .filter(Boolean);

  return [...new Set(values)];
}

function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^www\./, '');
}

function getBraveApiKey(): string {
  return process.env.BRAVE_API_KEY ?? '';
}
