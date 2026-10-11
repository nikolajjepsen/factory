import { describe, expect, it } from 'vitest';
import { selectWorkflow } from './select.js';

const all = new Set(['feature', 'bugfix', 'chore', 'docs']);
const issue = (labels: string[], type?: string) => ({
  labels: labels.map((name) => ({ name })),
  ...(type && { type: { name: type } }),
});

describe('selectWorkflow', () => {
  it('prefers the /factory workflow override, then a workflow: label', () => {
    expect(selectWorkflow(issue(['workflow:docs', 'bug']), all, 'chore')).toEqual({
      workflow: 'chore',
      reason: '/factory workflow',
    });
    expect(selectWorkflow(issue(['bug', 'workflow:docs']), all)).toEqual({
      workflow: 'docs',
      reason: 'label workflow:docs',
    });
  });

  it('maps the issue type, then plain labels, then falls back to feature', () => {
    expect(selectWorkflow(issue([], 'Bug'), all)).toEqual({
      workflow: 'bugfix',
      reason: 'issue-type bug',
    });
    expect(selectWorkflow(issue(['Chore']), all)).toEqual({
      workflow: 'chore',
      reason: 'label Chore',
    });
    expect(selectWorkflow(issue(['enhancement']), all)).toEqual({
      workflow: 'feature',
      reason: 'standard',
    });
  });

  it('fails clearly for a workflow that does not exist', () => {
    expect(() => selectWorkflow(issue(['workflow:nope']), all)).toThrow(
      'workflow "nope" (label workflow:nope) findes ikke. Kendte: feature, bugfix, chore, docs',
    );
  });
});
