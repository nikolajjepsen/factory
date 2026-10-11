import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { rateLimitsResult } from '../../test/support/fixtures.js';
import { AppServerClient } from './appServerClient.js';
import { CodexQuotaSource } from './codexQuotaSource.js';
import { type ConnectionExit, spawnAppServer } from './connection.js';

// These tests start a real child process: the fake app-server that replays recorded traffic.
const fakeServer = fileURLToPath(new URL('../../test/support/fakeAppServer.ts', import.meta.url));
const spawnFake = (...extra: string[]) =>
  spawnAppServer({ command: process.execPath, args: ['--import', 'tsx', fakeServer, ...extra] });
const clientInfo = { name: 'ai_factory', title: null, version: '0.0.0-test' };

describe('spawnAppServer with a real process', () => {
  it('runs the handshake and reads quota over stdio', async () => {
    const client = new AppServerClient({ clientInfo, connect: () => spawnFake() });
    await client.start();
    const source = new CodexQuotaSource({ client, ownsClient: true });
    try {
      await expect(source.readRaw()).resolves.toEqual(rateLimitsResult);
      expect((await source.read()).fiveHour.usedPercent).toBe(3);
    } finally {
      await source.close();
    }
    expect(client.state).toBe('stopped');
  });

  it('reports exit code and stderr when the process crashes', async () => {
    const conn = spawnFake('--crash-after-initialize');
    const exit = await new Promise<ConnectionExit>((resolve) => {
      conn.onExit(resolve);
      conn.onLine(() => undefined);
      conn.send(JSON.stringify({ id: 0, method: 'initialize', params: {} }));
      conn.send(JSON.stringify({ method: 'initialized' }));
    });
    expect(exit.code).toBe(3);
    expect(exit.stderrTail).toEqual(['fake app-server started', 'fake app-server crashing']);
  });

  it('reports a spawn error when the command does not exist', async () => {
    const conn = spawnAppServer({ command: 'ai-factory-no-such-command' });
    const exit = await new Promise<ConnectionExit>((resolve) => {
      conn.onExit(resolve);
    });
    expect(exit.spawnError?.message).toMatch(/ENOENT/);
  });
});
