import { describe, expect, it } from 'vitest';
import type { BoardItem } from '../github/board.js';
import { pickNext } from './picker.js';

const project = { name: 'ekvilibrium', repo: 'o/ekvilibrium', path: '/p' };
const item = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => ({
  itemId: `i${String(number)}`,
  status: 'Ready',
  repo: 'o/ekvilibrium',
  number,
  title: `Issue ${String(number)}`,
  url: `https://github.com/o/ekvilibrium/issues/${String(number)}`,
  open: true,
  labels: [],
  openSubIssues: [],
  openBlockers: [],
  ...overrides,
});
const ctx = (overrides = {}) => ({
  readyStatus: 'Ready',
  projectsByRepo: new Map([[project.repo, project]]),
  focus: null,
  hasRun: () => false,
  ...overrides,
});

describe('pickNext', () => {
  it('takes the first workable card in board order and explains every skipped one', () => {
    const items = [
      item(1, { status: 'In progress' }),
      item(2, { labels: ['factory:hold'] }),
      item(3, { openSubIssues: [4] }),
      item(5, { openBlockers: ['o/ekvilibrium#3'] }),
      item(6, { repo: 'o/unknown' }),
      item(7, { open: false }),
      item(8, { labels: ['factory:blocked'] }),
      item(9),
      item(10),
    ];
    const { queue, next } = pickNext(items, ctx());
    expect(next?.issue).toBe(9);
    expect(queue.map((q) => [q.issue, q.skip])).toEqual([
      [2, 'factory:hold'],
      [3, 'venter på sub-issues #4'],
      [5, 'blokeret af o/ekvilibrium#3'],
      [6, 'o/unknown er ikke i projects.yml'],
      [7, 'lukket'],
      [8, 'factory:blocked (brug /factory retry)'],
      [9, undefined],
      [10, undefined],
    ]);
  });

  it('respects focus and existing runs', () => {
    expect(pickNext([item(1)], ctx({ focus: 'loge-app' })).queue[0]?.skip).toBe(
      'fokus er på loge-app',
    );
    expect(pickNext([item(1)], ctx({ hasRun: () => true })).next).toBeUndefined();
  });

  it('returns no next card for an empty column', () => {
    expect(pickNext([], ctx())).toEqual({ queue: [] });
  });
});
