import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseWorkflow, phasesFor, WorkflowError } from './schema.js';

const parse = (yaml: string) => parseWorkflow('test', 'test.yml', parseYaml(yaml));

describe('parseWorkflow', () => {
  it('parses the example from BUILD_PLAN.md', () => {
    const workflow = parse(`
stages:
  - id: implement
    agent: implementer
    strategy: direct
    gates:
      - ci
      - review: { agent: reviewer, rubric: rubrics/code.md, min_score: 7 }
    on_fail: [retry_with_feedback x3, escalate: human]
`);
    expect(workflow.stages).toEqual([
      {
        id: 'implement',
        agent: 'implementer',
        strategy: 'direct',
        gates: [
          { kind: 'ci', on: 'code' },
          { kind: 'review', agent: 'reviewer', rubric: 'rubrics/code.md', minScore: 7, on: 'code' },
        ],
        onFail: [
          { kind: 'retry_with_feedback', times: 3 },
          { kind: 'escalate', to: 'human' },
        ],
      },
    ]);
  });

  it('accepts every ladder step and gate form, and fills in defaults', () => {
    const workflow = parse(`
stages:
  - id: a
    agent: implementer
    strategy: plan_then_code
    runner: codex
    instructions: Vær grundig.
    gates:
      - { ci: { on: plan } }
      - human: approve_pr
      - human: { mode: always, on: plan }
    on_fail:
      - retry_with_feedback
      - retry_with_feedback: 2
      - switch_strategy: direct
      - switch_runner: claude
      - switch_agent: galleri
      - escalate: human
  - id: b
    agent: docs
`);
    const [a, b] = workflow.stages;
    expect(a?.gates).toEqual([
      { kind: 'ci', on: 'plan' },
      { kind: 'human', mode: 'approve_pr', on: 'code' },
      { kind: 'human', mode: 'always', on: 'plan' },
    ]);
    expect(a?.onFail.map((s) => s.kind)).toEqual([
      'retry_with_feedback',
      'retry_with_feedback',
      'switch_strategy',
      'switch_runner',
      'switch_agent',
      'escalate',
    ]);
    expect(a?.onFail[0]).toEqual({ kind: 'retry_with_feedback', times: 1 });
    expect(a).toMatchObject({ runner: 'codex', instructions: 'Vær grundig.' });
    expect(b).toEqual({
      id: 'b',
      agent: 'docs',
      strategy: 'direct',
      gates: [],
      onFail: [{ kind: 'escalate', to: 'human' }],
    });
  });

  it.each([
    ['no stages', 'stages: []', /at least one stage/],
    ['unknown key', 'stages:\n  - id: a\n    agent: x\n    colour: red', /colour/],
    [
      'bad retry',
      'stages:\n  - id: a\n    agent: x\n    on_fail: [retry x3]',
      /retry_with_feedback xN/,
    ],
    ['bad strategy', 'stages:\n  - id: a\n    agent: x\n    strategy: yolo', /strategy/],
    [
      'duplicate ids',
      'stages:\n  - id: a\n    agent: x\n  - id: a\n    agent: y',
      /duplicate stage id "a"/,
    ],
    [
      'plan gate without plan',
      'stages:\n  - id: a\n    agent: x\n    gates: [{ ci: { on: plan } }]',
      /needs "strategy: plan_then_code"/,
    ],
    ['bad name', 'stages:\n  - id: Implement\n    agent: x', /kebab-case/],
    [
      'score out of range',
      'stages:\n  - id: a\n    agent: x\n    gates: [{ review: { agent: r, rubric: r.md, min_score: 11 } }]',
      /min_score/,
    ],
  ])('rejects %s with a clear message naming the file', (_name, yaml, message) => {
    expect(() => parse(yaml)).toThrow(WorkflowError);
    expect(() => parse(yaml)).toThrow(message);
    expect(() => parse(yaml)).toThrow(/^test\.yml is invalid/);
  });
});

describe('phasesFor', () => {
  it('lists the phases of each strategy', () => {
    expect(phasesFor('direct')).toEqual(['code']);
    expect(phasesFor('plan_then_code')).toEqual(['plan', 'code']);
  });
});
