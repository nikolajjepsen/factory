import {
  appendLog,
  type Command,
  CommandResult,
  EVENT,
  FactoryState,
  LogEvent,
  mergeState,
  SseParser,
  StateEvent,
} from '@ai-factory/protocol';
import { Listeners, type SourceEvent, type SourceStatus, type StateSource } from './source.js';

export interface DirectSourceOptions {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** First reconnect delay; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
}

/** `direct` mode: follows the daemon's `GET /events` and sends commands to `POST /commands`. */
export class DirectSource implements StateSource {
  readonly #options: Required<Omit<DirectSourceOptions, 'fetch'>> & { fetch: typeof fetch };
  readonly #listeners = new Listeners();
  #state: FactoryState | undefined;
  #status: SourceStatus = { mode: 'direct', connected: false, error: null, updatedAt: null };
  #abort: AbortController | undefined;
  #stopped = false;

  constructor(options: DirectSourceOptions) {
    this.#options = {
      fetch: options.fetch ?? globalThis.fetch,
      now: options.now ?? (() => new Date()),
      retryMs: options.retryMs ?? 1000,
      maxRetryMs: options.maxRetryMs ?? 15_000,
      apiUrl: options.apiUrl,
      token: options.token,
    };
  }

  status(): SourceStatus {
    return this.#status;
  }

  state(): FactoryState | undefined {
    return this.#state;
  }

  subscribe(listener: (event: SourceEvent) => void): () => void {
    return this.#listeners.add(listener);
  }

  start(): void {
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    this.#abort?.abort();
  }

  async command(command: Command): Promise<CommandResult> {
    const response = await this.#options.fetch(`${this.#options.apiUrl}/commands`, {
      method: 'POST',
      headers: { ...this.#auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!response.ok) {
      throw new Error(`Daemonen svarede ${String(response.status)}: ${await response.text()}`);
    }
    return CommandResult.parse(await response.json());
  }

  #auth() {
    return { Authorization: `Bearer ${this.#options.token}` };
  }

  async #loop(): Promise<void> {
    let delay = this.#options.retryMs;
    while (!this.#stopped) {
      try {
        await this.#follow();
        delay = this.#options.retryMs;
        this.#setStatus({ connected: false, error: 'Forbindelsen til daemonen blev lukket.' });
      } catch (error) {
        // stop() may run while #follow() awaits; TypeScript's narrowing cannot see that.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this.#stopped) return;
        this.#setStatus({ connected: false, error: describe(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, this.#options.maxRetryMs);
    }
  }

  /** One connection: resolves when the daemon closes the stream. */
  async #follow(): Promise<void> {
    this.#abort = new AbortController();
    const response = await this.#options.fetch(`${this.#options.apiUrl}/events`, {
      headers: { ...this.#auth(), Accept: 'text/event-stream' },
      signal: this.#abort.signal,
    });
    if (response.status === 401) throw new Error('Daemonen afviste tokenet (401).');
    if (!response.ok || !response.body) {
      throw new Error(`Daemonen svarede ${String(response.status)}.`);
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    // The first state and log events of a connection are full; the rest are changes.
    let fresh = true;
    let freshLog = true;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      for (const message of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (message.event === EVENT.state) {
          const event = StateEvent.parse(JSON.parse(message.data));
          if (fresh || !this.#state) {
            this.#state = FactoryState.parse({ ...event, log: this.#state?.log ?? [] });
            fresh = false;
            this.#setStatus({ connected: true, error: null });
            this.#listeners.emit({ type: 'reset', state: this.#state });
          } else {
            this.#state = mergeState(this.#state, event);
            this.#touch();
            this.#listeners.emit({ type: 'state', event });
          }
        } else if (message.event === EVENT.log && this.#state) {
          const { lines } = LogEvent.parse(JSON.parse(message.data));
          if (freshLog) {
            this.#state = { ...this.#state, log: lines };
            freshLog = false;
            this.#listeners.emit({ type: 'reset', state: this.#state });
          } else {
            this.#state = appendLog(this.#state, lines);
            this.#touch();
            this.#listeners.emit({ type: 'log', lines });
          }
        }
      }
    }
  }

  #touch(): void {
    this.#status = { ...this.#status, updatedAt: this.#options.now().toISOString() };
  }

  #setStatus(patch: Partial<SourceStatus>): void {
    this.#status = {
      ...this.#status,
      ...patch,
      ...(patch.connected && { updatedAt: this.#options.now().toISOString() }),
    };
    this.#listeners.emit({ type: 'status', status: this.#status });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error.cause as { code?: string } | undefined)?.code;
    if (code === 'ECONNREFUSED') return 'Daemonens API svarer ikke. Kører `factory daemon`?';
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
      return 'Forbindelsen til daemonen blev afbrudt.';
    }
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET')
      return 'Forbindelsen til daemonen blev afbrudt.';
    return error.message;
  }
  return String(error);
}
