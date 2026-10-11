import { z } from 'zod';
import type { QuotaSnapshot, QuotaSource } from '../../daemon/quota/quota.js';
import {
  AppServerClient,
  type AppServerClientOptions,
  type ClientInfo,
  type LogLevel,
} from './appServerClient.js';
import { applyRateLimitsUpdate, normalizeRateLimitsResponse } from './rateLimits.js';

export interface CodexQuotaSourceOptions {
  client: AppServerClient;
  /** When true, `close()` also stops the client. */
  ownsClient?: boolean;
  now?: () => Date;
  log?: (level: LogLevel, message: string) => void;
}

/** Reads the Codex plan quota through `codex app-server` and follows its push updates. */
export class CodexQuotaSource implements QuotaSource {
  readonly #client: AppServerClient;
  readonly #ownsClient: boolean;
  readonly #now: () => Date;
  readonly #log: (level: LogLevel, message: string) => void;
  readonly #listeners = new Set<(snapshot: QuotaSnapshot) => void>();
  readonly #unsubscribe: () => void;
  #last: QuotaSnapshot | undefined;

  constructor(options: CodexQuotaSourceOptions) {
    this.#client = options.client;
    this.#ownsClient = options.ownsClient ?? false;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => undefined);
    this.#unsubscribe = this.#client.onNotification('account/rateLimits/updated', (params) => {
      this.#onUpdated(params);
    });
  }

  /** The unparsed `account/rateLimits/read` result, for recording fixtures. */
  readRaw(): Promise<unknown> {
    return this.#client.request('account/rateLimits/read', {}, z.unknown());
  }

  async read(): Promise<QuotaSnapshot> {
    const raw = await this.readRaw();
    const snapshot = normalizeRateLimitsResponse(raw, this.#now());
    this.#last = snapshot;
    return snapshot;
  }

  subscribe(listener: (snapshot: QuotaSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#unsubscribe();
    this.#listeners.clear();
    if (this.#ownsClient) await this.#client.stop();
  }

  #onUpdated(params: unknown): void {
    // The update is sparse. Without a full read to merge into, wait for the next read().
    if (!this.#last) return;
    try {
      this.#last = applyRateLimitsUpdate(this.#last, params, this.#now());
    } catch (error) {
      this.#log('warn', `ignoring account/rateLimits/updated: ${String(error)}`);
      return;
    }
    for (const listener of this.#listeners) listener(this.#last);
  }
}

export interface OpenCodexQuotaSourceOptions {
  clientInfo: ClientInfo;
  connect?: AppServerClientOptions['connect'];
  log?: (level: LogLevel, message: string) => void;
}

/** Starts a dedicated app-server and returns a quota source that stops it on `close()`. */
export async function openCodexQuotaSource(
  options: OpenCodexQuotaSourceOptions,
): Promise<CodexQuotaSource> {
  const client = new AppServerClient(options);
  await client.start();
  return new CodexQuotaSource({ client, ownsClient: true, log: options.log });
}
