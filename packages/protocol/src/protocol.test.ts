import { describe, expect, it } from 'vitest';
import {
  appendLog,
  diffState,
  type FactoryState,
  mergeState,
  parseStatusBody,
  SseParser,
  statusBlock,
  withoutLog,
} from './index.js';

const state: FactoryState = {
  mode: 'idle',
  reason: null,
  heartbeat: '2026-10-11T18:00:00.000Z',
  nextStart: null,
  quota: null,
  quotaOverrideUntil: null,
  focus: null,
  projects: [],
  runners: ['codex'],
  halted: false,
  current: null,
  queue: [],
  waitingForYou: [],
  today: { prs: 0, merged: 0, firstPass: null },
  log: ['a'],
};

describe('state sync', () => {
  it('sends only changed fields, null included, and merges them back', () => {
    const next: FactoryState = { ...state, mode: 'paused', reason: 'x', log: ['a', 'b'] };
    const event = diffState(withoutLog(next), withoutLog({ ...next, reason: null }));
    expect(event).toEqual({ reason: null });
    expect(diffState(withoutLog(state), withoutLog(next))).toEqual({ mode: 'paused', reason: 'x' });
    expect(mergeState(state, { mode: 'paused' }).mode).toBe('paused');
    expect(appendLog(state, ['b', 'c'], 2).log).toEqual(['b', 'c']);
  });

  it('round-trips the state through the status issue block and rejects unknown shapes', () => {
    expect(parseStatusBody(`## Factory Status\n${statusBlock(state)}\ntekst`)).toEqual(state);
    expect(parseStatusBody('<!-- factory-status:v1\n{"mode":"flying"}\n-->')).toBeUndefined();
    expect(parseStatusBody('ingen blok')).toBeUndefined();
  });
});

describe('SseParser', () => {
  it('handles split chunks, comments, CRLF and multi-line data', () => {
    const parser = new SseParser();
    expect(parser.push('event: state\ndata: {"a"')).toEqual([]);
    expect(parser.push(':1}\n\n: ping\n\nevent: log\r\ndata: x\r\ndata: y\r\n\r\n')).toEqual([
      { event: 'state', data: '{"a":1}' },
      { event: 'log', data: 'x\ny' },
    ]);
  });
});
