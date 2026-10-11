import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { RunState } from './runState.js';
import { parseWorkflow } from './schema.js';
import { stepsFor } from './steps.js';

const workflow = parseWorkflow(
  'bugfix',
  'bugfix.yml',
  parseYaml(`
stages:
  - id: reproduce
    agent: reproducer
    gates: [ci]
  - id: fix
    agent: implementer
    strategy: plan_then_code
    gates:
      - review: { agent: reviewer, rubric: rubrics/plan.md, min_score: 7, on: plan }
      - ci
      - human: approve_pr
`),
);

const run = (patch: Partial<RunState>) => ({
  status: 'active' as const,
  stageIndex: 0,
  phase: 'code' as const,
  turnDone: false,
  gateIndex: 0,
  overrides: {},
  ...patch,
});

const states = (r: ReturnType<typeof run>) =>
  stepsFor(workflow, r).map((s) => `${s.label}:${s.state[0] ?? ''}`);

describe('stepsFor', () => {
  it('lists every agent turn and gate, with the plan phase first where the strategy has one', () => {
    expect(states(run({}))).toEqual([
      'reproduce:a',
      'CI:p',
      'fix: plan:p',
      'Review:p',
      'fix:p',
      'CI:p',
      'Godkendelse:p',
    ]);
  });

  it('marks the gate the run is on, and the next slot once all gates of a phase passed', () => {
    expect(states(run({ stageIndex: 1, phase: 'plan', turnDone: true, gateIndex: 0 }))).toEqual([
      'reproduce:d',
      'CI:d',
      'fix: plan:d',
      'Review:a',
      'fix:p',
      'CI:p',
      'Godkendelse:p',
    ]);
    expect(states(run({ stageIndex: 1, phase: 'plan', turnDone: true, gateIndex: 1 })).at(4)).toBe(
      'fix:a',
    );
  });

  it('uses the strategy override on the current stage and marks everything done at the end', () => {
    const switched = run({ phase: 'plan', overrides: { strategy: 'plan_then_code' } });
    expect(states(switched).slice(0, 3)).toEqual(['reproduce: plan:a', 'reproduce:p', 'CI:p']);
    expect(stepsFor(workflow, run({ status: 'done' })).every((s) => s.state === 'done')).toBe(true);
  });
});
