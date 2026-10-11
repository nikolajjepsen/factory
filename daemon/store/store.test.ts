import { describe, expect, it } from 'vitest';
import type { RunState } from '../workflow/runState.js';
import { type AttemptRecord, SqliteStore } from './store.js';

const run = (overrides: Partial<RunState> = {}): RunState => ({
  id: 'r1',
  project: 'demo',
  issue: 12,
  workflow: 'feature',
  status: 'active',
  branch: 'factory/12-x',
  stageIndex: 0,
  stageId: 'implement',
  phase: 'code',
  attempt: 1,
  ladderIndex: 0,
  ladderUsed: 0,
  overrides: {},
  feedback: [],
  turnDone: false,
  gateIndex: 0,
  createdAt: '2026-10-11T18:00:00.000Z',
  updatedAt: '2026-10-11T18:00:00.000Z',
  ...overrides,
});

const attempt = (overrides: Partial<AttemptRecord> = {}): AttemptRecord => ({
  runId: 'r1',
  project: 'demo',
  issue: 12,
  stage: 'implement',
  attempt: 1,
  phase: 'code',
  agent: 'implementer',
  runner: 'codex',
  strategy: 'direct',
  gate: null,
  score: null,
  passed: true,
  feedback: null,
  tokens: 1000,
  durationMs: 5000,
  ...overrides,
});

describe('SqliteStore', () => {
  it('saves, updates and finds open runs', () => {
    const store = new SqliteStore(':memory:');
    store.saveRun(run());
    store.saveRun(run({ attempt: 2, feedback: ['x'] }));
    expect(store.getRun('r1')).toMatchObject({ attempt: 2, feedback: ['x'] });
    expect(store.findOpenRun('demo', 12)?.id).toBe('r1');
    store.saveRun(run({ status: 'done' }));
    expect(store.findOpenRun('demo', 12)).toBeUndefined();
    store.saveRun(run({ id: 'r2', status: 'stopped', createdAt: '2026-10-11T19:00:00.000Z' }));
    expect(store.findOpenRun('demo', 12)?.id).toBe('r2');
    expect(store.listRuns(['done', 'stopped']).map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('logs attempts with every field and filters them', () => {
    const store = new SqliteStore(':memory:', () => new Date('2026-10-11T18:05:00.000Z'));
    store.logAttempt(attempt());
    store.logAttempt(
      attempt({ gate: 'review', score: 6.5, passed: false, feedback: 'Mangler test' }),
    );
    store.logAttempt(attempt({ runId: 'other', issue: 13 }));
    expect(store.attempts({ runId: 'r1' })).toEqual([
      { ...attempt(), createdAt: '2026-10-11T18:05:00.000Z' },
      {
        ...attempt({ gate: 'review', score: 6.5, passed: false, feedback: 'Mangler test' }),
        createdAt: '2026-10-11T18:05:00.000Z',
      },
    ]);
    expect(store.attempts({ project: 'demo', issue: 13 })).toHaveLength(1);
  });

  it('hands out each decision once, oldest first, per kind', () => {
    const store = new SqliteStore(':memory:');
    store.addDecision({ project: 'demo', issue: 12, kind: 'reject', feedback: 'første' });
    store.addDecision({ project: 'demo', issue: 12, kind: 'reject', feedback: 'anden' });
    store.addDecision({ project: 'demo', issue: 12, kind: 'approve', feedback: null });
    expect(store.takeDecision('demo', 12, 'reject')?.feedback).toBe('første');
    expect(store.takeDecision('demo', 12, 'reject')?.feedback).toBe('anden');
    expect(store.takeDecision('demo', 12, 'reject')).toBeUndefined();
    expect(store.takeDecision('demo', 12, 'approve')?.kind).toBe('approve');
  });

  it('keeps one workflow override per issue', () => {
    const store = new SqliteStore(':memory:');
    store.setWorkflowOverride('demo', 12, 'chore');
    store.setWorkflowOverride('demo', 12, 'bugfix');
    expect(store.getWorkflowOverride('demo', 12)).toBe('bugfix');
    expect(store.getWorkflowOverride('demo', 13)).toBeUndefined();
  });
});
