import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, CommandResult, FactoryState } from '@ai-factory/protocol';
import { describe, expect, it } from 'vitest';
import { createApi, listen } from './server.js';
import { loadOrCreateToken } from './token.js';

const TOKEN = 'test-token';
const auth = { Authorization: `Bearer ${TOKEN}` };

class FakeDaemon {
  commands: Command[] = [];
  readonly #change = new Set<() => void>();
  readonly #log = new Set<(line: string) => void>();
  current: FactoryState = {
    mode: 'idle',
    reason: null,
    heartbeat: '2026-10-11T18:00:00.000Z',
    nextStart: null,
    quota: null,
    quotaOverrideUntil: null,
    focus: null,
    current: null,
    queue: [],
    waitingForYou: [],
    today: { prs: 0, merged: 0, firstPass: null },
    log: ['20:00:00 Daemonen starter.'],
  };
  state(): FactoryState {
    return structuredClone(this.current);
  }
  execute(command: Command): Promise<CommandResult> {
    this.commands.push(command);
    if (command.command === 'pause') this.update({ mode: 'paused', reason: 'Sat på pause.' });
    if (command.command === 'resume') this.update({ mode: 'idle', reason: null });
    return Promise.resolve({ text: `ok: ${command.command}`, reply: false });
  }
  update(patch: Partial<FactoryState>): void {
    Object.assign(this.current, patch);
    for (const listener of this.#change) listener();
  }
  write(line: string): void {
    this.current.log.push(line);
    for (const listener of this.#log) listener(line);
  }
  onChange(listener: () => void) {
    this.#change.add(listener);
    return () => this.#change.delete(listener);
  }
  onLog(listener: (line: string) => void) {
    this.#log.add(listener);
    return () => this.#log.delete(listener);
  }
  get listeners() {
    return this.#change.size + this.#log.size;
  }
}

function setup() {
  const daemon = new FakeDaemon();
  const app = createApi({ daemon, token: TOKEN, debounceMs: 5 });
  return { daemon, app };
}

/** Reads SSE events from a response until `count` have arrived. */
async function readEvents(response: Response, count: number) {
  // Node's fetch types type the body's chunks as any; they are bytes.
  const reader = (
    response.body ?? new ReadableStream()
  ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) as unknown });
    }
  }
  return { events, close: () => reader.cancel() };
}

describe('daemon API', () => {
  it('answers 401 without a valid bearer token on every route', async () => {
    const { app, daemon } = setup();
    for (const [method, path] of [
      ['GET', '/state'],
      ['GET', '/events'],
      ['POST', '/commands'],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
      expect(
        (await app.request(path, { method, headers: { Authorization: 'Bearer wrong' } })).status,
      ).toBe(401);
    }
    expect(daemon.commands).toEqual([]);
  });

  it('returns the whole state', async () => {
    const { app } = setup();
    const response = await app.request('/state', { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: 'idle', today: { prs: 0 } });
  });

  it('runs commands through the daemon handler and rejects malformed ones', async () => {
    const { app, daemon } = setup();
    const post = (body: string) =>
      app.request('/commands', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body,
      });
    const ok = await post(JSON.stringify({ command: 'pause' }));
    expect(await ok.json()).toEqual({ text: 'ok: pause', reply: false });
    expect(daemon.current.mode).toBe('paused');
    expect((await post(JSON.stringify({ command: 'stop' }))).status).toBe(400);
    expect((await post(JSON.stringify({ command: 'dance' }))).status).toBe(400);
    expect((await post('{nope')).status).toBe(400);
    expect(daemon.commands).toEqual([{ command: 'pause' }]);
  });

  it('streams the whole state, then only changed fields and new log lines', async () => {
    const { app, daemon } = setup();
    const response = await app.request('/events', { headers: auth });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const first = await readEvents(response, 2);
    expect(first.events[0]?.event).toBe('state');
    expect(first.events[0]?.data).not.toHaveProperty('log');
    expect(first.events[1]).toEqual({
      event: 'log',
      data: { lines: ['20:00:00 Daemonen starter.'] },
    });
    await first.close();
    expect(daemon.listeners).toBe(0);

    const live = await app.request('/events', { headers: auth });
    const stream = readEvents(live, 4);
    await new Promise((resolve) => setTimeout(resolve, 10));
    daemon.update({ mode: 'paused', reason: 'Sat på pause.' });
    daemon.update({ focus: 'demo' });
    daemon.write('20:01:00 Kommando /factory pause');
    const { events, close } = await stream;
    expect(events.slice(2)).toEqual([
      { event: 'log', data: { lines: ['20:01:00 Kommando /factory pause'] } },
      { event: 'state', data: { mode: 'paused', reason: 'Sat på pause.', focus: 'demo' } },
    ]);
    await close();
  });

  it('listens on 127.0.0.1 only and serves over real HTTP', async () => {
    const { app } = setup();
    const server = await listen(app, 0);
    try {
      const url = `http://127.0.0.1:${String(server.port)}/state`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: auth })).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('loadOrCreateToken', () => {
  it('creates a random token readable only by the owner, then reuses it', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ai-factory-token-')), 'api-token');
    const token = await loadOrCreateToken(file);
    expect(token).toMatch(/^[\w-]{43}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateToken(file)).toBe(token);
    expect((await readFile(file, 'utf8')).trim()).toBe(token);
  });

  it('tightens an existing token file to 0600', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'ai-factory-token-')), 'api-token');
    await writeFile(file, 'mine\n', { mode: 0o644 });
    expect(await loadOrCreateToken(file)).toBe('mine');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
