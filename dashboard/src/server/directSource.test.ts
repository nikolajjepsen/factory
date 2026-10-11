import type { Command, CommandResult, FactoryState } from '@ai-factory/protocol';
import { describe, expect, it } from 'vitest';
import { createApi, listen } from '../../../daemon/api/server.js';
import { sampleState } from '../test/sample.js';
import { DirectSource } from './directSource.js';
import type { SourceEvent } from './source.js';

/** The daemon side, behind the real daemon API server. */
class FakeDaemon {
  current: FactoryState = sampleState();
  commands: Command[] = [];
  readonly #change = new Set<() => void>();
  readonly #log = new Set<(line: string) => void>();
  state() {
    return structuredClone(this.current);
  }
  execute(command: Command): Promise<CommandResult> {
    this.commands.push(command);
    return Promise.resolve({ text: 'Fabrikken holder pause.', reply: false });
  }
  update(patch: Partial<FactoryState>) {
    Object.assign(this.current, patch);
    for (const l of this.#change) l();
  }
  write(line: string) {
    this.current.log.push(line);
    for (const l of this.#log) l(line);
  }
  onChange(l: () => void) {
    this.#change.add(l);
    return () => this.#change.delete(l);
  }
  onLog(l: (line: string) => void) {
    this.#log.add(l);
    return () => this.#log.delete(l);
  }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

describe('DirectSource', () => {
  it('follows the daemon API, merges changes and sends commands', async () => {
    const daemon = new FakeDaemon();
    const server = await listen(createApi({ daemon, token: 't', debounceMs: 5 }), 0);
    const source = new DirectSource({
      apiUrl: `http://127.0.0.1:${String(server.port)}`,
      token: 't',
    });
    const events: SourceEvent[] = [];
    source.subscribe((e) => events.push(e));
    source.start();
    try {
      await until(() => source.state()?.log.length === 3);
      expect(source.status()).toMatchObject({ mode: 'direct', connected: true, error: null });
      expect(events.some((e) => e.type === 'reset')).toBe(true);

      daemon.update({ mode: 'paused', reason: 'Sat på pause.' });
      daemon.write('22:00:00 Kommando /factory pause');
      await until(() => source.state()?.mode === 'paused');
      await until(() => source.state()?.log.at(-1) === '22:00:00 Kommando /factory pause');
      expect(events).toContainEqual({
        type: 'state',
        event: { mode: 'paused', reason: 'Sat på pause.' },
      });

      expect(await source.command({ command: 'pause' })).toEqual({
        text: 'Fabrikken holder pause.',
        reply: false,
      });
      expect(daemon.commands).toEqual([{ command: 'pause' }]);
    } finally {
      source.stop();
      await server.close();
    }
  });

  it('says so when the token is wrong or the daemon is down', async () => {
    const daemon = new FakeDaemon();
    const server = await listen(createApi({ daemon, token: 't' }), 0);
    const wrong = new DirectSource({
      apiUrl: `http://127.0.0.1:${String(server.port)}`,
      token: 'x',
      retryMs: 10_000,
    });
    wrong.start();
    await until(() => wrong.status().error !== null);
    expect(wrong.status()).toMatchObject({
      connected: false,
      error: 'Daemonen afviste tokenet (401).',
    });
    wrong.stop();
    await server.close();

    // A port nobody has connected to, so no kept-alive connection answers.
    const closed = await listen(createApi({ daemon, token: 't' }), 0);
    await closed.close();
    const down = new DirectSource({
      apiUrl: `http://127.0.0.1:${String(closed.port)}`,
      token: 't',
      retryMs: 10_000,
    });
    down.start();
    await until(() => down.status().error !== null);
    expect(down.status().error).toBe('Daemonens API svarer ikke. Kører `factory daemon`?');
    down.stop();
  });
});
