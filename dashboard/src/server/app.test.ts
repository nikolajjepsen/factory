import type { Command, CommandResult, FactoryState } from '@ai-factory/protocol';
import { describe, expect, it } from 'vitest';
import { sampleState } from '../test/sample.js';
import { createApp } from './app.js';
import { Listeners, type SourceEvent, type SourceStatus, type StateSource } from './source.js';

class FakeSource implements StateSource {
  readonly listeners = new Listeners();
  commands: Command[] = [];
  fail = false;
  current: FactoryState | undefined = sampleState();
  status(): SourceStatus {
    return { mode: 'direct', connected: true, error: null, updatedAt: null };
  }
  state() {
    return this.current;
  }
  subscribe(listener: (event: SourceEvent) => void) {
    return this.listeners.add(listener);
  }
  command(command: Command): Promise<CommandResult> {
    if (this.fail) return Promise.reject(new Error('Daemonen svarede 500.'));
    this.commands.push(command);
    return Promise.resolve({ text: 'ok', reply: false });
  }
  start() {
    // Nothing to start in tests.
  }
  stop() {
    // Nothing to stop in tests.
  }
}

const post = (
  app: ReturnType<typeof createApp>,
  body: string,
  headers: Record<string, string> = {},
) =>
  app.request('/api/commands', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: 'dashboard.ai-factory.orb.local',
      ...headers,
    },
    body,
  });

async function readEvents(response: Response, count: number) {
  const reader = (
    response.body ?? new ReadableStream()
  ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let text = '';
  while ((text.match(/\n\n/g) ?? []).length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => ({
      event: /^event: (.*)$/m.exec(b)?.[1],
      data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? 'null') as unknown,
    }));
}

describe('dashboard server', () => {
  it('passes valid JSON commands to the source and reports its errors', async () => {
    const source = new FakeSource();
    const app = createApp({ source, name: 'Nikolaj' });
    expect(await (await post(app, '{"command":"pause"}')).json()).toEqual({
      text: 'ok',
      reply: false,
    });
    expect(source.commands).toEqual([{ command: 'pause' }]);
    expect((await post(app, '{"command":"stop"}')).status).toBe(400);
    source.fail = true;
    const failed = await post(app, '{"command":"resume"}');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'Daemonen svarede 500.' });
  });

  it('refuses commands that are not JSON or come from another site', async () => {
    const source = new FakeSource();
    const app = createApp({ source, name: null });
    expect(
      (await post(app, 'command=halt', { 'Content-Type': 'application/x-www-form-urlencoded' }))
        .status,
    ).toBe(415);
    expect((await post(app, '{"command":"halt"}', { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    expect(
      (await post(app, '{"command":"halt"}', { Origin: 'https://dashboard.ai-factory.orb.local' }))
        .status,
    ).toBe(200);
    expect(source.commands).toEqual([{ command: 'halt' }]);
  });

  it('streams the source, the full state and the log, then forwards changes', async () => {
    const source = new FakeSource();
    const app = createApp({ source, name: null });
    const response = await app.request('/api/events');
    setTimeout(() => {
      source.listeners.emit({ type: 'state', event: { mode: 'paused' } });
      source.listeners.emit({ type: 'log', lines: ['22:00:00 Kommando /factory pause'] });
    }, 10);
    const events = await readEvents(response, 5);
    expect(events.map((e) => e.event)).toEqual(['source', 'state', 'log', 'state', 'log']);
    expect(events[2]?.data).toMatchObject({ reset: true });
    expect(events[3]?.data).toEqual({ mode: 'paused' });
    expect(events[4]?.data).toEqual({ lines: ['22:00:00 Kommando /factory pause'] });
  });

  it('serves its config and health', async () => {
    const app = createApp({ source: new FakeSource(), name: 'Nikolaj' });
    expect(await (await app.request('/api/config')).json()).toEqual({
      name: 'Nikolaj',
      mode: 'direct',
    });
    expect(await (await app.request('/healthz')).text()).toBe('ok');
  });
});
