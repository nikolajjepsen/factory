import { describe, expect, it } from 'vitest';
import type { RunState } from '../workflow/runState.js';
import { todayStats } from './today.js';

const timeZone = 'Europe/Copenhagen';
// Sunday 11 October 2026, 20:00 in Copenhagen.
const now = new Date('2026-10-11T18:00:00.000Z');

const run = (id: string, overrides: Partial<RunState> = {}): RunState => ({
  id,
  project: 'demo',
  issue: Number(id.slice(1)),
  workflow: 'feature',
  status: 'done',
  branch: 'b',
  stageIndex: 0,
  stageId: 'implement',
  phase: 'code',
  attempt: 1,
  ladderIndex: 0,
  ladderUsed: 0,
  overrides: {},
  feedback: [],
  turnDone: true,
  gateIndex: 0,
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
  ...overrides,
});

const attempt = (
  runId: string,
  stage: string,
  n: number,
  passed: boolean,
  at = '2026-10-11T12:00:00.000Z',
) => ({
  runId,
  stage,
  attempt: n,
  passed,
  createdAt: at,
});

describe('todayStats', () => {
  it('counts PRs opened today, which of them merged, and first-pass stages', () => {
    const pr = (number: number, openedAt: string) => ({ number, url: 'u', openedAt });
    const runs = [
      run('r1', { pr: pr(10, '2026-10-11T08:00:00.000Z') }),
      run('r2', { pr: pr(11, '2026-10-11T09:00:00.000Z') }),
      // Opened late Saturday in Copenhagen: not today.
      run('r3', { pr: pr(12, '2026-10-10T21:30:00.000Z') }),
      run('r4', { status: 'active', stageId: 'implement' }),
      run('r5', { status: 'blocked' }),
    ];
    const attempts = [
      attempt('r1', 'implement', 1, true),
      attempt('r1', 'implement', 1, true),
      attempt('r2', 'implement', 1, false),
      attempt('r2', 'implement', 2, true),
      // Still working on this stage: not finished.
      attempt('r4', 'implement', 1, true),
      // Ended on a failure: not finished.
      attempt('r5', 'implement', 1, false),
      // Yesterday: ignored.
      attempt('r3', 'implement', 1, true, '2026-10-10T21:30:00.000Z'),
    ];
    expect(
      todayStats({ runs, attempts, merged: new Set(['demo#10', 'demo#12']), now, timeZone }),
    ).toEqual({ prs: 2, merged: 1, firstPass: 50 });
  });

  it('has no first-pass rate before a stage is finished', () => {
    expect(todayStats({ runs: [], attempts: [], merged: new Set(), now, timeZone })).toEqual({
      prs: 0,
      merged: 0,
      firstPass: null,
    });
  });
});
