import { describe, expect, it } from 'vitest';
import { FakeWorkspace } from '../../test/support/fakeWorkspace.js';
import { finishRun } from './finishRun.js';
import type { AgentReport, RunTask } from './runner.js';

const report: AgentReport = {
  status: 'done',
  summary: 'Tilføjede add() med test.',
  testsRun: ['node --test'],
  commitMessage: 'Add add() with test',
};

function task(workspace = new FakeWorkspace()): RunTask & { workspace: FakeWorkspace } {
  return { id: 'demo#1', role: 'implementer', prompt: '', workspace };
}

describe('finishRun', () => {
  it('commits with the agent message and reports success', async () => {
    const t = task();
    const result = await finishRun(t, {
      kind: 'completed',
      report,
      tokens: { input: 1, output: 2, total: 3 },
    });
    expect(t.workspace.commitMessages).toEqual(['Add add() with test']);
    expect(result).toEqual({
      status: 'success',
      summary: report.summary,
      testsRun: ['node --test'],
      branch: 'factory/1-demo',
      commits: ['sha1'],
      tokens: { input: 1, output: 2, total: 3 },
    });
  });

  it('reports a blocked agent as failed and keeps its work as WIP', async () => {
    const t = task();
    const result = await finishRun(t, {
      kind: 'completed',
      report: { ...report, status: 'blocked' },
    });
    expect(result.status).toBe('failed');
    expect(result.summary).toBe(report.summary);
    expect(t.workspace.commitMessages).toEqual(['WIP: demo#1 (blocked)']);
  });

  it('makes a WIP commit when interrupted', async () => {
    const t = task();
    const result = await finishRun(t, { kind: 'interrupted' });
    expect(result.status).toBe('interrupted');
    expect(result.summary).toBe(
      'Afbrudt. Arbejdet indtil nu er gemt som en WIP-commit på branchen.',
    );
    expect(t.workspace.commitMessages).toEqual(['WIP: demo#1 (interrupted)']);
  });

  it('says nothing was saved when interrupted before any change', async () => {
    const workspace = new FakeWorkspace();
    workspace.dirty = false;
    const result = await finishRun(task(workspace), { kind: 'interrupted' });
    expect(result.summary).toBe(
      'Afbrudt. Agenten havde ikke ændret noget endnu, så der var intet at gemme.',
    );
    expect(result.commits).toEqual([]);
  });

  it('makes a WIP commit and carries the error when the turn failed', async () => {
    const t = task();
    const result = await finishRun(t, { kind: 'failed', error: 'boom' });
    expect(result).toMatchObject({ status: 'failed', summary: 'boom', commits: ['sha1'] });
    expect(result.tokens).toBeUndefined();
  });

  it('reports no commits when nothing changed', async () => {
    const workspace = new FakeWorkspace();
    workspace.dirty = false;
    const result = await finishRun(task(workspace), { kind: 'completed', report });
    expect(result.commits).toEqual([]);
    expect(workspace.commitMessages).toEqual([]);
  });
});
