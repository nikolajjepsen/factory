import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  codexResponder,
  FakeConnection,
  fakeConnections,
} from '../../test/support/fakeConnection.js';
import { errorLines, initializeResult, transcript } from '../../test/support/fixtures.js';
import {
  AppServerClient,
  type AppServerClientOptions,
  AppServerExitedError,
  AppServerProtocolError,
  AppServerRpcError,
  AppServerStoppedError,
  AppServerTimeoutError,
  type ClientState,
} from './appServerClient.js';

const clientInfo = { name: 'ai_factory', title: 'ai-factory', version: '0.0.0-test' };
const Echo = z.object({ echo: z.string() });

function createClient(options: Partial<AppServerClientOptions> = {}) {
  const fakes = fakeConnections();
  const logs: string[] = [];
  const client = new AppServerClient({
    clientInfo,
    connect: fakes.connect,
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...options,
  });
  return { client, fakes, logs };
}

/** Lets queued microtasks (fake replies, promise chains) run. Works with fake timers too. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AppServerClient handshake', () => {
  it('sends initialize, then initialized, and returns the server info', async () => {
    const { client, fakes } = createClient();
    await expect(client.start()).resolves.toEqual(initializeResult);
    expect(client.state).toBe('ready');
    expect(fakes.latest().sent).toEqual([
      { id: 0, method: 'initialize', params: { clientInfo, capabilities: null } },
      { method: 'initialized' },
    ]);
  });

  it('rejects start() and stops when the first launch fails, without restarting', async () => {
    const fakes = fakeConnections(() => undefined);
    const client = new AppServerClient({ clientInfo, connect: fakes.connect });
    const started = client.start();
    fakes.latest().exit({ spawnError: new Error('spawn codex ENOENT') });
    await expect(started).rejects.toThrow(/could not start: spawn codex ENOENT/);
    expect(client.state).toBe('stopped');
    expect(fakes.connections).toHaveLength(1);
  });

  it('includes stderr in the error when the process exits during start', async () => {
    const fakes = fakeConnections(() => undefined);
    const client = new AppServerClient({ clientInfo, connect: fakes.connect });
    const started = client.start();
    fakes.latest().exit({ code: 1, stderrTail: ['Error: not logged in'] });
    await expect(started).rejects.toThrow(/exited with code 1[\s\S]*not logged in/);
  });

  it('refuses requests before start()', async () => {
    const { client } = createClient();
    await expect(client.request('x', {}, Echo)).rejects.toThrow(/call start\(\)/);
  });
});

describe('AppServerClient requests', () => {
  it('correlates answers that arrive out of order', async () => {
    const { client, fakes } = createClient();
    await client.start();
    const conn = fakes.latest();
    const first = client.request('test/echo', { n: 1 }, Echo);
    const second = client.request('test/echo', { n: 2 }, Echo);
    const [firstSent, secondSent] = conn.sent.slice(-2);
    conn.emit({ id: secondSent?.id, result: { echo: 'two' } });
    conn.emit({ id: firstSent?.id, result: { echo: 'one' } });
    await expect(first).resolves.toEqual({ echo: 'one' });
    await expect(second).resolves.toEqual({ echo: 'two' });
  });

  it('turns an error answer into AppServerRpcError', async () => {
    const { client, fakes } = createClient();
    await client.start();
    const pending = client.request('does/not/exist', {}, Echo);
    const recorded = JSON.parse(errorLines[1] ?? '') as { error: object };
    fakes.latest().emit({ id: fakes.latest().sent.at(-1)?.id, error: recorded.error });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppServerRpcError);
    expect(error).toMatchObject({ code: -32600, method: 'does/not/exist' });
  });

  it('rejects a result with the wrong shape', async () => {
    const { client, fakes } = createClient();
    await client.start();
    const pending = client.request('test/echo', {}, Echo);
    fakes.latest().emit({ id: fakes.latest().sent.at(-1)?.id, result: { echo: 42 } });
    await expect(pending).rejects.toBeInstanceOf(AppServerProtocolError);
  });

  it('times out when no answer arrives', async () => {
    vi.useFakeTimers();
    const { client } = createClient({ requestTimeoutMs: 5_000 });
    await client.start();
    const pending = client.request('test/slow', {}, Echo);
    const assertion = expect(pending).rejects.toBeInstanceOf(AppServerTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it('logs and ignores non-JSON lines and answers to unknown ids', async () => {
    const { client, fakes, logs } = createClient();
    await client.start();
    fakes.latest().emit('not json');
    fakes.latest().emit({ id: 999, result: {} });
    expect(logs).toEqual([
      'warn: ignoring non-JSON line from codex app-server: not json',
      'warn: answer for unknown request id 999',
    ]);
  });

  it('answers server requests it does not support, so the server never waits', async () => {
    const { client, fakes } = createClient();
    await client.start();
    fakes.latest().emit({ id: 'srv-1', method: 'item/tool/call', params: {} });
    expect(fakes.latest().sent.at(-1)).toEqual({
      id: 'srv-1',
      error: { code: -32601, message: 'ai-factory does not handle item/tool/call' },
    });
  });
});

describe('AppServerClient notifications', () => {
  it('dispatches recorded notifications to subscribers until they unsubscribe', async () => {
    const { client, fakes } = createClient();
    await client.start();
    const received: unknown[] = [];
    const unsubscribe = client.onNotification('account/updated', (params) => received.push(params));
    fakes.latest().emit(transcript[3] ?? '');
    unsubscribe();
    fakes.latest().emit(transcript[3] ?? '');
    expect(received).toEqual([{ authMode: 'chatgpt', planType: 'plus' }]);
  });

  it('keeps dispatching when one handler throws', async () => {
    const { client, fakes, logs } = createClient();
    await client.start();
    const received: unknown[] = [];
    client.onNotification('x/y', () => {
      throw new Error('boom');
    });
    client.onNotification('x/y', (params) => received.push(params));
    fakes.latest().emit({ method: 'x/y', params: 1 });
    expect(received).toEqual([1]);
    expect(logs).toContain('error: notification handler for x/y threw: Error: boom');
  });
});

describe('AppServerClient restarts', () => {
  it('rejects pending requests, restarts after backoff and serves requests sent meanwhile', async () => {
    vi.useFakeTimers();
    const { client, fakes } = createClient({ backoff: { initialMs: 1_000 } });
    const states: ClientState[] = [];
    client.onStateChange((state) => states.push(state));
    await client.start();

    const inFlight = client.request('test/echo', {}, Echo);
    fakes.latest().exit({ code: null, signal: 'SIGKILL' });
    await expect(inFlight).rejects.toBeInstanceOf(AppServerExitedError);
    expect(client.state).toBe('restarting');

    const waiting = client.request('test/echo', { after: 'restart' }, Echo);
    await vi.advanceTimersByTimeAsync(999);
    expect(fakes.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(fakes.connections).toHaveLength(2);
    expect(client.state).toBe('ready');

    const second = fakes.latest();
    const echo = second.sent.find((m) => m.method === 'test/echo');
    second.emit({ id: echo?.id, result: { echo: 'back' } });
    await expect(waiting).resolves.toEqual({ echo: 'back' });
    expect(states).toEqual(['starting', 'ready', 'restarting', 'ready']);
  });

  it('backs off exponentially while restarts fail, and resets after a success', async () => {
    vi.useFakeTimers();
    let failing = true;
    const fakes = fakeConnections((message, conn) => {
      if (failing && message.method === 'initialize') {
        queueMicrotask(() => {
          conn.exit({ code: 1 });
        });
        return;
      }
      codexResponder()(message, conn);
    });
    const client = new AppServerClient({
      clientInfo,
      connect: fakes.connect,
      backoff: { initialMs: 1_000, factor: 2, maxMs: 3_000 },
    });
    failing = false;
    await client.start();
    failing = true;

    const restartTimes: number[] = [];
    const start = Date.now();
    const originalConnect = fakes.connections.length;
    fakes.latest().exit({ code: 1 });
    for (let i = 0; i < 4; i++) {
      const before = fakes.connections.length;
      while (fakes.connections.length === before) await vi.advanceTimersByTimeAsync(100);
      restartTimes.push(Date.now() - start);
      await flush();
    }
    // Delays of 1 s, 2 s, then capped at 3 s.
    expect(restartTimes).toEqual([1_000, 3_000, 6_000, 9_000]);
    expect(fakes.connections.length - originalConnect).toBe(4);

    failing = false;
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(client.state).toBe('ready');

    // After a successful restart the next crash starts over at 1 s.
    const before = fakes.connections.length;
    fakes.latest().exit({ code: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakes.connections.length).toBe(before + 1);
  });
});

describe('AppServerClient stop', () => {
  it('kills the process, rejects pending requests and does not restart', async () => {
    vi.useFakeTimers();
    const { client, fakes } = createClient();
    await client.start();
    const pending = client.request('test/echo', {}, Echo);
    const assertion = expect(pending).rejects.toBeInstanceOf(AppServerStoppedError);
    await client.stop();
    await assertion;
    expect(fakes.latest().killed).toBe(true);
    expect(client.state).toBe('stopped');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakes.connections).toHaveLength(1);
    await expect(client.request('test/echo', {}, Echo)).rejects.toBeInstanceOf(
      AppServerStoppedError,
    );
  });

  it('cancels a scheduled restart', async () => {
    vi.useFakeTimers();
    const { client, fakes } = createClient();
    await client.start();
    fakes.latest().exit({ code: 1 });
    expect(client.state).toBe('restarting');
    const waiting = client.request('test/echo', {}, Echo);
    const assertion = expect(waiting).rejects.toBeInstanceOf(AppServerStoppedError);
    await client.stop();
    await assertion;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakes.connections).toHaveLength(1);
  });

  it('ignores events from a connection it already replaced', async () => {
    vi.useFakeTimers();
    const { client, fakes } = createClient();
    await client.start();
    const old = fakes.latest();
    old.exit({ code: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    const received: unknown[] = [];
    client.onNotification('x/y', (params) => received.push(params));
    old.emit({ method: 'x/y', params: 'stale' });
    expect(received).toEqual([]);
    expect(fakes.latest()).not.toBe(old);
    expect(fakes.latest()).toBeInstanceOf(FakeConnection);
  });
});
