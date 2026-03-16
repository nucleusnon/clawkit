import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type AuditLevel = 'info' | 'warn' | 'error';

export interface AuditEvent {
  timestamp: string;
  level: AuditLevel;
  action: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface AuditLoggerOptions {
  logFilePath?: string;
  verbose?: boolean;
}

export class AuditLogger {
  private readonly logFilePath: string;
  private readonly verbose: boolean;

  constructor(options: AuditLoggerOptions = {}) {
    this.logFilePath = resolve(options.logFilePath ?? 'logs/audit.jsonl');
    this.verbose = options.verbose ?? false;
    mkdirSync(dirname(this.logFilePath), { recursive: true });
  }

  info(action: string, message: string, data?: Record<string, unknown>): void {
    this.log(action, message, data, 'info');
  }

  warn(action: string, message: string, data?: Record<string, unknown>): void {
    this.log(action, message, data, 'warn');
  }

  error(action: string, message: string, data?: Record<string, unknown>): void {
    this.log(action, message, data, 'error');
  }

  private log(
    action: string,
    message: string,
    data: Record<string, unknown> | undefined,
    level: AuditLevel,
  ): void {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      level,
      action,
      message,
      ...(data ? { data } : {}),
    };

    appendFileSync(this.logFilePath, `${JSON.stringify(event)}\n`, 'utf8');

    if (this.verbose) {
      const metadata = data ? ` ${JSON.stringify(data)}` : '';
      console.log(`[audit:${level}] ${action} ${message}${metadata}`);
    }
  }
}
