import { describe, expect, it } from 'vitest';
import { fakeConnections } from '../../test/support/fakeConnection.js';
import { rateLimitsResult } from '../../test/support/fixtures.js';
import type { QuotaSnapshot } from '../../daemon/quota/quota.js';
import { AppServerClient } from './appServerClient.js';
import { CodexQuotaSource, openCodexQuotaSource } from './codexQuotaSource.js';

const clientInfo = { name: 'ai_factory', title: null, version: '0.0.0-test' };
const now = new Date('2026-10-11T16:21:33.000Z');
const updated = (usedPercent: number) => ({
  method: 'account/rateLimits/updated',
  params: { rateLimits: { primary: { usedPercent, windowDurationMins: 300, resetsAt: null } } },
});

async function setup() {
  const fakes = fakeConnections();
  const client = new AppServerClient({ clientInfo, connect: fakes.connect });
  await client.start();
  const logs: string[] = [];
  const source = new CodexQuotaSource({
    client,
    now: () => now,
    log: (level, message) => logs.push(`${level}: ${message}`),
  });
  return { fakes, client, source, logs };
}

describe('CodexQuotaSource', () => {
  it('reads and normalizes account/rateLimits/read', async () => {
    const { source, fakes } = await setup();
    const snapshot = await source.read();
    expect(fakes.latest().sent.at(-1)).toMatchObject({
      method: 'account/rateLimits/read',
      params: {},
    });
    expect(snapshot).toMatchObject({
      fiveHour: { usedPercent: 3 },
      weekly: { usedPercent: 0 },
      fetchedAt: now.toISOString(),
    });
  });

  it('returns the raw answer from readRaw()', async () => {
    const { source } = await setup();
    await expect(source.readRaw()).resolves.toEqual(rateLimitsResult);
  });

  it('pushes merged snapshots on account/rateLimits/updated after the first read', async () => {
    const { source, fakes } = await setup();
    const pushed: QuotaSnapshot[] = [];
    source.subscribe((snapshot) => pushed.push(snapshot));

    fakes.latest().emit(updated(50));
    expect(pushed).toEqual([]);

    const first = await source.read();
    fakes.latest().emit(updated(20));
    expect(pushed).toEqual([
      { ...first, fiveHour: { usedPercent: 20, resetsAt: first.fiveHour.resetsAt } },
    ]);
  });

  it('logs and skips an update it cannot parse', async () => {
    const { source, fakes, logs } = await setup();
    const pushed: QuotaSnapshot[] = [];
    source.subscribe((snapshot) => pushed.push(snapshot));
    await source.read();
    fakes.latest().emit({ method: 'account/rateLimits/updated', params: { rateLimits: 'broken' } });
    expect(pushed).toEqual([]);
    expect(logs[0]).toMatch(/^warn: ignoring account\/rateLimits\/updated/);
  });

  it('stops listening on close() and leaves a shared client running', async () => {
    const { source, client, fakes } = await setup();
    const pushed: QuotaSnapshot[] = [];
    source.subscribe((snapshot) => pushed.push(snapshot));
    await source.read();
    await source.close();
    fakes.latest().emit(updated(20));
    expect(pushed).toEqual([]);
    expect(client.state).toBe('ready');
  });

  it('stops its own client when opened with openCodexQuotaSource()', async () => {
    const fakes = fakeConnections();
    const source = await openCodexQuotaSource({ clientInfo, connect: fakes.connect });
    await source.read();
    await source.close();
    expect(fakes.latest().killed).toBe(true);
  });
});
