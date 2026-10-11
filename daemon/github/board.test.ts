import { describe, expect, it } from 'vitest';
import { readJsonFixture } from '../../test/support/fixtures.js';
import { parseBoardPage } from './board.js';

describe('parseBoardPage', () => {
  it('reads the recorded Features board in board order', () => {
    const { data } = readJsonFixture('github/board-items.json') as { data: unknown };
    const { snapshot, next } = parseBoardPage(data);
    expect(next).toBeNull();
    expect(snapshot.projectId).toBe('PVT_kwHOAIRcqc4Bmlox');
    expect([...snapshot.statusOptions.keys()]).toEqual([
      'Backlog',
      'Ready',
      'In progress',
      'In review',
      'Done',
    ]);
    expect(snapshot.items.map((i) => [i.number, i.status])).toEqual([
      [1, 'In progress'],
      [2, 'In progress'],
      [5, 'Backlog'],
      [6, 'In progress'],
    ]);
    expect(snapshot.items[0]).toEqual({
      itemId: 'PVTI_lAHOAIRcqc4BmloxzhABhx4',
      status: 'In progress',
      repo: 'nikolajjepsen/ekvilibrium',
      number: 1,
      title: 'Tilføj clamp(value, min, max)',
      url: 'https://github.com/nikolajjepsen/ekvilibrium/issues/1',
      open: true,
      labels: [],
      openSubIssues: [],
      openBlockers: [],
    });
  });

  it('keeps only open sub-issues and blockers, and skips non-issue cards', () => {
    const node = (content: unknown, status: string | null = 'Ready') => ({
      id: 'item',
      fieldValueByName: status ? { name: status } : null,
      content,
    });
    const issue = {
      __typename: 'Issue',
      number: 9,
      title: 'Epic',
      state: 'OPEN',
      url: 'u',
      repository: { nameWithOwner: 'o/r' },
      labels: { nodes: [{ name: 'factory:hold' }] },
      subIssues: {
        nodes: [
          { number: 10, state: 'OPEN' },
          { number: 11, state: 'CLOSED' },
        ],
      },
      blockedBy: {
        nodes: [{ number: 3, state: 'OPEN', repository: { nameWithOwner: 'o/other' } }],
      },
    };
    const data = {
      user: {
        projectV2: {
          id: 'p',
          field: { id: 'f', options: [{ id: 'a', name: 'Ready' }] },
          items: {
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
            nodes: [node(issue), node({ __typename: 'DraftIssue' }), node(null)],
          },
        },
      },
    };
    const { snapshot, next } = parseBoardPage(data);
    expect(next).toBe('c1');
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      labels: ['factory:hold'],
      openSubIssues: [10],
      openBlockers: ['o/other#3'],
    });
  });

  it('explains a missing board or Status field', () => {
    expect(() => parseBoardPage({ user: { projectV2: null } })).toThrow(/scopet "project"/);
    expect(() =>
      parseBoardPage({
        user: {
          projectV2: {
            id: 'p',
            field: null,
            items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      }),
    ).toThrow(/"Status"/);
  });
});
