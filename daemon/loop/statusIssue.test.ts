import { describe, expect, it } from 'vitest';
import { FakeGitHub } from '../../test/support/fakeGitHub.js';
import { isOffline, type FactoryState } from './state.js';
import { parseStatusIssue, renderStatusIssue, StatusIssue } from './statusIssue.js';

const state: FactoryState = {
  mode: 'running',
  heartbeat: '2026-10-11T18:00:00.000Z',
  nextStart: null,
  focus: 'ekvilibrium',
  current: {
    project: 'ekvilibrium',
    issue: 6,
    title: 'Tilføj sum',
    url: 'https://github.com/o/ekvilibrium/issues/6',
    workflow: 'feature',
    stage: 'implement',
    phase: 'code',
    attempt: 2,
    since: '2026-10-11T17:58:00.000Z',
  },
  queue: [
    { project: 'ekvilibrium', issue: 8, title: 'Næste', url: 'u8' },
    { project: 'ekvilibrium', issue: 9, title: 'Holdt', url: 'u9', skip: 'factory:hold' },
  ],
  waitingForYou: [
    {
      project: 'ekvilibrium',
      issue: 5,
      kind: 'blocked',
      text: 'Eskaleret til et menneske.',
      url: 'u5',
    },
  ],
  log: ['20:00:00 Daemonen starter.'],
};

describe('renderStatusIssue', () => {
  it('writes a Danish summary without emojis and the state as JSON', () => {
    const body = renderStatusIssue(state, 'Europe/Copenhagen');
    expect(body).toContain('**Tilstand:** Kører');
    expect(body).toContain('**Heartbeat:** 2026-10-11 20:00:00');
    expect(body).toContain(
      '[ekvilibrium#6](https://github.com/o/ekvilibrium/issues/6) Tilføj sum – workflow `feature`, stage `implement` (code), forsøg 2',
    );
    expect(body).toContain('- [ekvilibrium#9](u9) Holdt – _springes over: factory:hold_');
    expect(body).toContain('- Blokeret: [ekvilibrium#5](u5) Eskaleret til et menneske.');
    expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(parseStatusIssue(body)).toEqual(state);
  });

  it('marks empty sections and an error reason', () => {
    const body = renderStatusIssue({
      ...state,
      mode: 'error',
      reason: 'GitHub svarer ikke',
      current: null,
      queue: [],
      waitingForYou: [],
      log: [],
    });
    expect(body).toContain('**Tilstand:** Fejl – GitHub svarer ikke');
    expect(body).toContain('_Intet lige nu._');
    expect(body).toContain('_Tom._');
    expect(body).not.toContain('Seneste log');
  });

  it('returns undefined for a body without state', () => {
    expect(parseStatusIssue('hello')).toBeUndefined();
  });
});

describe('StatusIssue', () => {
  it('creates and pins the issue once, then edits its body', async () => {
    const github = new FakeGitHub();
    const issue = new StatusIssue(github, 'o/factory');
    const number = await issue.publish(state);
    await issue.publish({ ...state, mode: 'idle' });
    expect(github.createdIssues.map((i) => i.title)).toEqual(['Factory Status']);
    expect(github.pinned).toEqual([number]);
    expect(github.issueBodies.get(number)).toContain('**Tilstand:** Ledig');
  });

  it('reuses an existing status issue after a restart', async () => {
    const github = new FakeGitHub();
    await new StatusIssue(github, 'o/factory').publish(state);
    await new StatusIssue(github, 'o/factory').publish({ ...state, mode: 'paused' });
    expect(github.createdIssues).toHaveLength(1);
    expect(github.pinned).toHaveLength(1);
  });
});

describe('isOffline', () => {
  it('is true when the heartbeat is older than 5 minutes', () => {
    const now = new Date('2026-10-11T18:05:01.000Z');
    expect(isOffline({ heartbeat: '2026-10-11T18:00:00.000Z' }, now)).toBe(true);
    expect(isOffline({ heartbeat: '2026-10-11T18:01:00.000Z' }, now)).toBe(false);
  });
});
