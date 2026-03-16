import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { AuditLogger } from '../security/audit.js';

export interface MemoryRecord {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  score?: number;
}

export interface MemoryOptions {
  dbPath?: string;
  dimensions?: number;
  audit?: AuditLogger;
  verbose?: boolean;
}

interface MemoryRow {
  id: number;
  content: string;
  embedding: string;
  metadata: string;
  created_at: string;
}

export class VectorMemory {
  private readonly db: Database.Database;
  private readonly dimensions: number;
  private readonly audit?: AuditLogger;
  private readonly verbose: boolean;

  constructor(options: MemoryOptions = {}) {
    const dbPath = resolve(options.dbPath ?? 'memory/memory.db');
    this.dimensions = options.dimensions ?? 128;
    this.audit = options.audit;
    this.verbose = options.verbose ?? false;

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.migrate();

    this.audit?.info('memory.init', 'Initialized vector memory', {
      dbPath,
      dimensions: this.dimensions,
    });

    if (this.verbose) {
      console.log(`Memory ready at ${dbPath} (${this.dimensions} dimensions)`);
    }
  }

  add(content: string, metadata: Record<string, unknown> = {}): MemoryRecord {
    const normalized = content.trim();
    if (!normalized) {
      throw new Error('Memory content cannot be empty.');
    }

    const embedding = embedText(normalized, this.dimensions);
    const createdAt = new Date().toISOString();

    const result = this.db
      .prepare(
        `
          INSERT INTO memories (content, embedding, metadata, created_at)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(
        normalized,
        JSON.stringify(embedding),
        JSON.stringify(metadata),
        createdAt,
      );

    const record: MemoryRecord = {
      id: Number(result.lastInsertRowid),
      content: normalized,
      metadata,
      createdAt,
    };

    this.audit?.info('memory.add', 'Stored memory entry', {
      id: record.id,
      chars: normalized.length,
    });

    return record;
  }

  search(query: string, limit = 5): MemoryRecord[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const queryEmbedding = embedText(normalizedQuery, this.dimensions);
    const rows = this.db
      .prepare(
        `
          SELECT id, content, embedding, metadata, created_at
          FROM memories
          ORDER BY id DESC
          LIMIT 5000
        `,
      )
      .all() as MemoryRow[];

    const ranked = rows
      .map((row) => {
        const embedding = safelyParseEmbedding(row.embedding, this.dimensions);
        return {
          row,
          score: cosineSimilarity(queryEmbedding, embedding),
        };
      })
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit, 1));

    const records = ranked.map((item) => ({
      id: item.row.id,
      content: item.row.content,
      metadata: safelyParseMetadata(item.row.metadata),
      createdAt: item.row.created_at,
      score: Number(item.score.toFixed(4)),
    }));

    this.audit?.info('memory.search', 'Memory search completed', {
      queryLength: normalizedQuery.length,
      resultCount: records.length,
    });

    return records;
  }

  close(): void {
    this.db.close();
    this.audit?.info('memory.close', 'Closed vector memory');
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
  }
}

export function embedText(input: string, dimensions = 128): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const normalized = input.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const h1 = fnv1a(token);
    const h2 = fnv1a(`${token}:alt`);
    const i1 = Math.abs(h1) % dimensions;
    const i2 = Math.abs(h2) % dimensions;
    const s1 = (h1 & 1) === 0 ? 1 : -1;
    const s2 = (h2 & 1) === 0 ? 1 : -1;

    vector[i1] += s1;
    vector[i2] += 0.5 * s2;
  }

  const magnitude = Math.hypot(...vector);
  if (magnitude === 0) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA === 0 || magB === 0) {
    return 0;
  }

  return dot / Math.sqrt(magA * magB);
}

function safelyParseEmbedding(value: string, dimensions: number): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return new Array<number>(dimensions).fill(0);
    }

    return parsed
      .slice(0, dimensions)
      .map((entry) => (typeof entry === 'number' ? entry : 0));
  } catch {
    return new Array<number>(dimensions).fill(0);
  }
}

function safelyParseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}
