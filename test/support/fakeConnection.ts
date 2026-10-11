import type { AppServerConnection, ConnectionExit } from '../../runners/codex/connection.js';
import { initializeResult, rateLimitsResult } from './fixtures.js';

export interface SentMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

type Responder = (message: SentMessage, connection: FakeConnection) => void;

/** In-memory stand-in for one app-server process. */
export class FakeConnection implements AppServerConnection {
  readonly sent: SentMessage[] = [];
  killed = false;
  exited = false;
  readonly #lineListeners: ((line: string) => void)[] = [];
  readonly #exitListeners: ((exit: ConnectionExit) => void)[] = [];

  constructor(private readonly responder?: Responder) {}

  send(line: string): void {
    const message = JSON.parse(line) as SentMessage;
    this.sent.push(message);
    this.responder?.(message, this);
  }

  onLine(listener: (line: string) => void): void {
    this.#lineListeners.push(listener);
  }

  onExit(listener: (exit: ConnectionExit) => void): void {
    this.#exitListeners.push(listener);
  }

  kill(): void {
    this.killed = true;
    queueMicrotask(() => {
      this.exit({ signal: 'SIGTERM' });
    });
  }

  emit(message: object | string): void {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    for (const listener of this.#lineListeners) listener(line);
  }

  /** Answers asynchronously, like a real process would. */
  reply(id: number | string | undefined, result: unknown): void {
    queueMicrotask(() => {
      this.emit({ id, result });
    });
  }

  exit(exit: Partial<ConnectionExit> = {}): void {
    if (this.exited) return;
    this.exited = true;
    const full: ConnectionExit = { code: null, signal: null, stderrTail: [], ...exit };
    for (const listener of this.#exitListeners) listener(full);
  }
}

/** Answers `initialize` and `account/rateLimits/read` with the recorded fixtures. */
export const codexResponder =
  (rateLimits: unknown = rateLimitsResult): Responder =>
  (message, connection) => {
    if (message.method === 'initialize') connection.reply(message.id, initializeResult);
    if (message.method === 'account/rateLimits/read') connection.reply(message.id, rateLimits);
  };

/** A connection factory that records every connection it creates. */
export function fakeConnections(responder: Responder = codexResponder()) {
  const connections: FakeConnection[] = [];
  const connect = () => {
    const connection = new FakeConnection(responder);
    connections.push(connection);
    return connection;
  };
  return {
    connections,
    connect,
    latest: () => {
      const connection = connections.at(-1);
      if (!connection) throw new Error('no connection created yet');
      return connection;
    },
  };
}
