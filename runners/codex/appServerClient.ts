import { z } from 'zod';
import {
  type AppServerConnection,
  type ConnectionExit,
  type ConnectionFactory,
  spawnAppServer,
} from './connection.js';
import { classifyMessage, type RequestId, type RpcErrorBody, RpcErrorCode } from './jsonRpc.js';

export const InitializeResponse = z.looseObject({
  userAgent: z.string(),
  codexHome: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
});
export type InitializeResponse = z.infer<typeof InitializeResponse>;

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

/**
 * - `idle`: created, `start()` not called yet.
 * - `starting`: first launch. A failure here rejects `start()` and does not restart.
 * - `ready`: initialized and accepting requests.
 * - `restarting`: the process died after being ready. Requests wait until it is back.
 * - `stopped`: `stop()` was called, or the first launch failed.
 */
export type ClientState = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopped';

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppServerClientOptions {
  clientInfo: ClientInfo;
  connect?: ConnectionFactory;
  /** Applies to each request, including the wait for a restart. */
  requestTimeoutMs?: number;
  backoff?: Partial<BackoffOptions>;
  log?: (level: LogLevel, message: string) => void;
}

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(
    readonly method: string,
    body: RpcErrorBody,
  ) {
    super(`${method} failed with ${String(body.code)}: ${body.message}`);
    this.name = 'AppServerRpcError';
    this.code = body.code;
    this.data = body.data;
  }
}

export class AppServerExitedError extends Error {
  constructor(readonly exit: ConnectionExit) {
    const cause = exit.spawnError
      ? `could not start: ${exit.spawnError.message}`
      : `exited with code ${String(exit.code)}, signal ${String(exit.signal)}`;
    const stderr = exit.stderrTail.length > 0 ? `\n${exit.stderrTail.join('\n')}` : '';
    super(`codex app-server ${cause}${stderr}`);
    this.name = 'AppServerExitedError';
  }
}

export class AppServerTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`${method} got no answer within ${String(timeoutMs)} ms`);
    this.name = 'AppServerTimeoutError';
  }
}

export class AppServerProtocolError extends Error {
  constructor(method: string, cause: z.ZodError) {
    super(`${method} returned an unexpected shape: ${z.prettifyError(cause)}`, { cause });
    this.name = 'AppServerProtocolError';
  }
}

export class AppServerStoppedError extends Error {
  constructor() {
    super('codex app-server client is stopped');
    this.name = 'AppServerStoppedError';
  }
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

const defaultBackoff: BackoffOptions = { initialMs: 1_000, maxMs: 60_000, factor: 2 };

/**
 * JSON-RPC client for `codex app-server` over stdio. It performs the `initialize` handshake,
 * correlates request ids, dispatches notifications and restarts the process with exponential
 * backoff if it crashes.
 */
export class AppServerClient {
  readonly #clientInfo: ClientInfo;
  readonly #connectFactory: ConnectionFactory;
  readonly #timeoutMs: number;
  readonly #backoff: BackoffOptions;
  readonly #log: (level: LogLevel, message: string) => void;

  #state: ClientState = 'idle';
  #conn: AppServerConnection | undefined;
  // Ids keep counting across restarts, so a late answer from a dead process never matches.
  #nextId = 0;
  readonly #pending = new Map<RequestId, Pending>();
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  readonly #stateListeners = new Set<(state: ClientState) => void>();
  #restartAttempt = 0;
  #restartTimer: NodeJS.Timeout | undefined;

  constructor(options: AppServerClientOptions) {
    this.#clientInfo = options.clientInfo;
    this.#connectFactory = options.connect ?? (() => spawnAppServer());
    this.#timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#backoff = { ...defaultBackoff, ...options.backoff };
    this.#log = options.log ?? (() => undefined);
  }

  get state(): ClientState {
    return this.#state;
  }

  async start(): Promise<InitializeResponse> {
    if (this.#state !== 'idle') throw new Error(`cannot start a client in state ${this.#state}`);
    this.#setState('starting');
    try {
      return await this.#connect();
    } catch (error) {
      this.#teardown();
      this.#setState('stopped');
      this.#rejectReadyWaiters(error instanceof Error ? error : new AppServerStoppedError());
      throw error;
    }
  }

  /** Sends a request and validates the result with `schema`. Waits for a restart in progress. */
  async request<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const deadline = Date.now() + this.#timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    // When ready, the request is written before this method returns. Otherwise wait; the
    // process may crash again between becoming ready and this continuation, hence the loop.
    for (;;) {
      if (this.#state === 'ready' && this.#conn) {
        return this.#send(this.#conn, method, params, schema, remaining());
      }
      await this.#whenReady(method, remaining());
    }
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.#notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.#notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  onStateChange(listener: (state: ClientState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Stops the process and any pending restart. Resolves when the process has exited. */
  async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    this.#setState('stopped');
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    this.#rejectPending(new AppServerStoppedError());
    this.#rejectReadyWaiters(new AppServerStoppedError());
    const conn = this.#conn;
    this.#conn = undefined;
    if (!conn) return;
    await new Promise<void>((resolve) => {
      conn.onExit(() => {
        resolve();
      });
      conn.kill();
    });
  }

  async #connect(): Promise<InitializeResponse> {
    const conn = this.#connectFactory();
    this.#conn = conn;
    // Events from a connection we already replaced or tore down are ignored.
    conn.onLine((line) => {
      if (this.#conn === conn) this.#handleLine(conn, line);
    });
    conn.onExit((exit) => {
      if (this.#conn === conn) this.#handleExit(exit);
    });
    const result = await this.#send(
      conn,
      'initialize',
      { clientInfo: this.#clientInfo, capabilities: null },
      InitializeResponse,
      this.#timeoutMs,
    );
    conn.send(JSON.stringify({ method: 'initialized' }));
    this.#restartAttempt = 0;
    this.#setState('ready');
    for (const waiter of this.#readyWaiters) waiter.resolve();
    this.#readyWaiters.clear();
    return result;
  }

  #send<T>(
    conn: AppServerConnection,
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    timeoutMs: number,
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (raw) => {
          clearTimeout(timer);
          const parsed = schema.safeParse(raw);
          if (parsed.success) resolve(parsed.data);
          else reject(new AppServerProtocolError(method, parsed.error));
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      conn.send(JSON.stringify({ id, method, params }));
    });
  }

  #whenReady(method: string, timeoutMs: number): Promise<void> {
    switch (this.#state) {
      case 'ready':
        return Promise.resolve();
      case 'idle':
        return Promise.reject(new Error('call start() before sending requests'));
      case 'stopped':
        return Promise.reject(new AppServerStoppedError());
      case 'starting':
      case 'restarting':
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.#readyWaiters.delete(waiter);
            reject(new AppServerTimeoutError(method, this.#timeoutMs));
          }, timeoutMs);
          const waiter: ReadyWaiter = {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          this.#readyWaiters.add(waiter);
        });
    }
  }

  #handleLine(conn: AppServerConnection, line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#log('warn', `ignoring non-JSON line from codex app-server: ${line}`);
      return;
    }
    const message = classifyMessage(value);
    if (!message) {
      this.#log('warn', `ignoring unknown message from codex app-server: ${line}`);
      return;
    }
    switch (message.kind) {
      case 'success':
      case 'error': {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          this.#log('warn', `answer for unknown request id ${String(message.id)}`);
          return;
        }
        this.#pending.delete(message.id);
        if (message.kind === 'success') pending.resolve(message.result);
        else pending.reject(new AppServerRpcError(pending.method, message.error));
        return;
      }
      case 'notification':
        this.#dispatchNotification(message.method, message.params);
        return;
      case 'request':
        // M1 handles no server requests. Answer so the server does not wait forever.
        this.#log('warn', `rejecting unsupported server request ${message.method}`);
        conn.send(
          JSON.stringify({
            id: message.id,
            error: {
              code: RpcErrorCode.methodNotFound,
              message: `ai-factory does not handle ${message.method}`,
            },
          }),
        );
        return;
    }
  }

  #dispatchNotification(method: string, params: unknown): void {
    for (const handler of this.#notificationHandlers.get(method) ?? []) {
      try {
        handler(params);
      } catch (error) {
        this.#log('error', `notification handler for ${method} threw: ${String(error)}`);
      }
    }
  }

  #handleExit(exit: ConnectionExit): void {
    this.#conn = undefined;
    const error = new AppServerExitedError(exit);
    this.#rejectPending(error);
    // While starting or restarting, the failed `initialize` is the one that reacts.
    if (this.#state !== 'ready') return;
    this.#log('warn', error.message);
    this.#scheduleRestart();
  }

  #scheduleRestart(): void {
    this.#setState('restarting');
    const { initialMs, maxMs, factor } = this.#backoff;
    const delay = Math.min(maxMs, initialMs * factor ** this.#restartAttempt);
    this.#restartAttempt++;
    this.#log('info', `restarting codex app-server in ${String(delay)} ms`);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#restart();
    }, delay);
  }

  async #restart(): Promise<void> {
    if (this.#state !== 'restarting') return;
    try {
      await this.#connect();
      this.#log('info', 'codex app-server restarted');
    } catch (error) {
      // stop() may have run during the await; TypeScript's narrowing cannot see that.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.#state !== 'restarting') return;
      this.#log('warn', `restart failed: ${String(error)}`);
      this.#teardown();
      this.#scheduleRestart();
    }
  }

  #teardown(): void {
    const conn = this.#conn;
    this.#conn = undefined;
    conn?.kill();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #rejectReadyWaiters(error: Error): void {
    for (const waiter of this.#readyWaiters) waiter.reject(error);
    this.#readyWaiters.clear();
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) listener(state);
  }
}
