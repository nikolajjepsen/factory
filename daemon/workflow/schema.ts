import { z } from 'zod';

// A workflow is a list of stages. Each stage runs an agent, checks its work with gates in order,
// and climbs an escalation ladder (`on_fail`) when a gate fails. See docs/workflows.md.

export const STRATEGIES = ['direct', 'plan_then_code'] as const;
/**
 * What a stage's agent turn delivers. `pr`: code on the branch and a PR. `comment`: a read-only
 * turn whose text is posted on the issue. `issues`: a read-only turn whose answer becomes
 * sub-issues of the issue.
 */
export const OUTPUTS = ['pr', 'comment', 'issues'] as const;
export type Output = (typeof OUTPUTS)[number];
export const HUMAN_MODES = ['always', 'approve_pr', 'answer', 'merge'] as const;
export type HumanMode = (typeof HUMAN_MODES)[number];
export type Strategy = (typeof STRATEGIES)[number];
export type Phase = 'plan' | 'code';

const Name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case, e.g. implementer');
const Phase = z.enum(['plan', 'code']);

const ReviewGate = z.object({
  agent: Name,
  rubric: z.string().regex(/^[\w./-]+\.md$/, 'must be a .md path, e.g. rubrics/code.md'),
  min_score: z.number().min(0).max(10),
  on: Phase.default('code'),
});

const CiGate = z.object({ on: Phase.default('code') }).default({ on: 'code' });

const HumanGate = z.union([
  z.enum(HUMAN_MODES).transform((mode) => ({ mode, on: 'code' as Phase })),
  z.object({ mode: z.enum(HUMAN_MODES), on: Phase.default('code') }),
]);

export type Gate =
  | { kind: 'ci'; on: Phase }
  | { kind: 'review'; agent: string; rubric: string; minScore: number; on: Phase }
  | { kind: 'human'; mode: HumanMode; on: Phase };

/**
 * Parses a one-key mapping such as `{ review: {...} }` by looking at the key first, so errors name
 * the right field instead of zod's generic "Invalid input" for unions.
 */
function keyed<T>(
  what: string,
  fromString: (value: string) => T | undefined,
  variants: Record<string, z.ZodType<T>>,
  hint: string,
) {
  return z.unknown().transform((value, ctx): T => {
    if (typeof value === 'string') {
      const parsed = fromString(value);
      if (parsed !== undefined) return parsed;
      ctx.addIssue({ code: 'custom', message: `unknown ${what} "${value}". ${hint}` });
      return z.NEVER;
    }
    const keys = value !== null && typeof value === 'object' ? Object.keys(value) : [];
    const key = keys[0];
    const schema = key !== undefined && keys.length === 1 ? variants[key] : undefined;
    if (!schema || key === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `a ${what} must be a single key${keys.length > 0 ? ` (got ${keys.join(', ')})` : ''}. ${hint}`,
      });
      return z.NEVER;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues)
      ctx.addIssue({ ...issue, code: 'custom', path: issue.path });
    return z.NEVER;
  });
}

const GATE_HINT =
  'Use ci, review: { agent, rubric, min_score } or human: always | approve_pr | answer | merge.';

const GateInput = keyed<Gate>(
  'gate',
  (value) => (value === 'ci' ? { kind: 'ci', on: 'code' } : undefined),
  {
    ci: z.object({ ci: CiGate }).transform(({ ci }): Gate => ({ kind: 'ci', on: ci.on })),
    review: z.object({ review: ReviewGate.strict() }).transform(({ review }): Gate => ({
      kind: 'review',
      agent: review.agent,
      rubric: review.rubric,
      minScore: review.min_score,
      on: review.on,
    })),
    human: z
      .object({ human: HumanGate })
      .transform(({ human }): Gate => ({ kind: 'human', ...human })),
  },
  GATE_HINT,
);

export type LadderStep =
  | { kind: 'retry_with_feedback'; times: number }
  | { kind: 'switch_strategy'; strategy: Strategy }
  | { kind: 'switch_runner'; runner: string }
  | { kind: 'switch_agent'; agent: string }
  | { kind: 'escalate'; to: 'human' };

const RETRY = /^retry_with_feedback(?:\s+x(\d+))?$/;
const LADDER_HINT =
  'Use "retry_with_feedback xN", switch_strategy, switch_runner, switch_agent or escalate: human.';

const LadderInput = keyed<LadderStep>(
  'ladder step',
  (value) => {
    const match = RETRY.exec(value);
    return match ? { kind: 'retry_with_feedback', times: Number(match[1] ?? 1) } : undefined;
  },
  {
    retry_with_feedback: z
      .object({ retry_with_feedback: z.number().int().positive() })
      .transform((s): LadderStep => ({
        kind: 'retry_with_feedback',
        times: s.retry_with_feedback,
      })),
    switch_strategy: z
      .object({ switch_strategy: z.enum(STRATEGIES) })
      .transform((s): LadderStep => ({ kind: 'switch_strategy', strategy: s.switch_strategy })),
    switch_runner: z
      .object({ switch_runner: Name })
      .transform((s): LadderStep => ({ kind: 'switch_runner', runner: s.switch_runner })),
    switch_agent: z
      .object({ switch_agent: Name })
      .transform((s): LadderStep => ({ kind: 'switch_agent', agent: s.switch_agent })),
    escalate: z
      .object({ escalate: z.literal('human') })
      .transform((): LadderStep => ({ kind: 'escalate', to: 'human' })),
  },
  LADDER_HINT,
);

const StageInput = z.strictObject({
  id: Name,
  agent: Name,
  strategy: z.enum(STRATEGIES).default('direct'),
  output: z.enum(OUTPUTS).default('pr'),
  runner: Name.optional(),
  /** Extra instructions for this stage, added to the agent's prompt. */
  instructions: z.string().optional(),
  gates: z.array(GateInput).default([]),
  on_fail: z
    .array(LadderInput)
    .min(1)
    .default([{ kind: 'escalate', to: 'human' }]),
});

export interface Stage {
  id: string;
  agent: string;
  strategy: Strategy;
  output: Output;
  runner?: string;
  instructions?: string;
  gates: Gate[];
  onFail: LadderStep[];
}

export const WorkflowInput = z
  .strictObject({
    description: z.string().optional(),
    stages: z.array(StageInput).min(1, 'a workflow needs at least one stage'),
  })
  .superRefine((workflow, ctx) => {
    const seen = new Set<string>();
    workflow.stages.forEach((stage, i) => {
      if (seen.has(stage.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['stages', i, 'id'],
          message: `duplicate stage id "${stage.id}"`,
        });
      }
      seen.add(stage.id);
      if (stage.output !== 'pr' && stage.strategy !== 'direct') {
        ctx.addIssue({
          code: 'custom',
          path: ['stages', i, 'strategy'],
          message: `"output: ${stage.output}" needs "strategy: direct"`,
        });
      }
      stage.gates.forEach((gate, g) => {
        const needsPr =
          gate.kind === 'ci' ||
          (gate.kind === 'human' && (gate.mode === 'approve_pr' || gate.mode === 'merge'));
        if (needsPr && stage.output !== 'pr') {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', i, 'gates', g],
            message: `${describeGate(gate)} needs a PR, so the stage must have "output: pr"`,
          });
        }
        if (gate.on === 'plan' && stage.strategy !== 'plan_then_code') {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', i, 'gates', g],
            message: 'a gate with "on: plan" needs "strategy: plan_then_code" on its stage',
          });
        }
      });
    });
  });

export interface Workflow {
  /** The file id: the file name without `.yml`. */
  id: string;
  description?: string;
  stages: Stage[];
  /** Where the workflow was loaded from, for messages. */
  source: string;
}

export function parseWorkflow(id: string, source: string, raw: unknown): Workflow {
  const parsed = WorkflowInput.safeParse(raw);
  if (!parsed.success) {
    throw new WorkflowError(`${source} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    id,
    source,
    ...(parsed.data.description !== undefined && { description: parsed.data.description }),
    stages: parsed.data.stages.map((s) => ({
      id: s.id,
      agent: s.agent,
      strategy: s.strategy,
      output: s.output,
      gates: s.gates,
      onFail: s.on_fail,
      ...(s.runner !== undefined && { runner: s.runner }),
      ...(s.instructions !== undefined && { instructions: s.instructions }),
    })),
  };
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowError';
  }
}

/** The phases a strategy runs through, in order. */
export function phasesFor(strategy: Strategy): Phase[] {
  return strategy === 'plan_then_code' ? ['plan', 'code'] : ['code'];
}

export function describeStep(step: LadderStep): string {
  switch (step.kind) {
    case 'retry_with_feedback':
      return `retry_with_feedback x${String(step.times)}`;
    case 'switch_strategy':
      return `switch_strategy: ${step.strategy}`;
    case 'switch_runner':
      return `switch_runner: ${step.runner}`;
    case 'switch_agent':
      return `switch_agent: ${step.agent}`;
    case 'escalate':
      return 'escalate: human';
  }
}

export function describeGate(gate: Gate): string {
  switch (gate.kind) {
    case 'ci':
      return 'ci';
    case 'review':
      return `review (${gate.agent}, min ${String(gate.minScore)})`;
    case 'human':
      return `human: ${gate.mode}`;
  }
}
