import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRun, FakeGitHub } from '../../test/support/fakeGitHub.js';
import { FakeWorkspace } from '../../test/support/fakeWorkspace.js';
import { ScriptRunner } from '../../test/support/scriptRunner.js';
import { factoryRoot, type Project } from '../config/projects.js';
import { QuotaExhaustedError, type Runner } from '../runner/runner.js';
import { SqliteStore } from '../store/store.js';
import { type EngineEvent, LABELS, WorkflowEngine } from './engine.js';
import { AgentLibrary } from './load.js';
import type { RunState } from './runState.js';

const baselineDir = join(factoryRoot, 'agents', 'baseline');

interface HarnessOptions {
  /** Workflow files written to the project's `.factory/workflows/`, by file id. */
  workflows?: Record<string, string>;
  /** Extra agent files in the project's `.factory/agents/`. */
  agents?: string[];
  /** Files written relative to the project, e.g. `.factory/project.yml` or `docs/ui.md`. */
  files?: Record<string, string>;
  runners?: Runner[];
}

async function harness(options: HarnessOptions = {}) {
  const projectPath = await mkdtemp(join(tmpdir(), 'ai-factory-engine-'));
  const factoryDir = join(projectPath, '.factory');
  await mkdir(join(factoryDir, 'workflows'), { recursive: true });
  await mkdir(join(factoryDir, 'agents'), { recursive: true });
  for (const [id, yaml] of Object.entries(options.workflows ?? {})) {
    await writeFile(join(factoryDir, 'workflows', `${id}.yml`), yaml);
  }
  for (const agent of options.agents ?? []) {
    await writeFile(join(factoryDir, 'agents', `${agent}.md`), `# ${agent}\n`);
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    await mkdir(join(projectPath, path, '..'), { recursive: true });
    await writeFile(join(projectPath, path), content);
  }
  const project: Project = { name: 'demo', repo: 'o/demo', path: projectPath };
  const github = new FakeGitHub();
  github.checkRunSequence = [[checkRun()]];
  let clock = new Date('2026-10-11T18:00:00.000Z').getTime();
  const now = () => new Date(clock);
  const store = new SqliteStore(':memory:', now);
  const runner = new ScriptRunner('codex');
  const runners = new Map<string, Runner>([[runner.name, runner]]);
  for (const extra of options.runners ?? []) runners.set(extra.name, extra);
  const workspace = new FakeWorkspace(projectPath, 'factory/12-tilfoej-add');
  const events: EngineEvent[] = [];
  const addedToBoard: string[] = [];
  let ids = 0;
  const engine = new WorkflowEngine({
    github,
    store,
    runners,
    defaultRunner: 'codex',
    worktrees: { prepare: () => Promise.resolve(workspace) },
    project: () => Promise.resolve(project),
    library: (p) => new AgentLibrary(baselineDir, join(p.path, '.factory')),
    ownerLogin: 'nikolajjepsen',
    board: {
      addToReady: (contentId) => {
        addedToBoard.push(contentId);
        return Promise.resolve();
      },
    },
    ci: {
      pollMs: 15_000,
      timeoutMs: 30 * 60_000,
      noChecksGraceMs: 3 * 60_000,
      now,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    },
    now,
    newId: () => `run-${String(++ids)}`,
    onEvent: (event) => events.push(event),
  });
  const ladder = () => events.flatMap((e) => (e.type === 'ladder' ? [e.step] : []));
  const statusMessages = () => events.flatMap((e) => (e.type === 'status' ? [e.message] : []));
  const tick = (ms: number) => {
    clock += ms;
  };
  return {
    engine,
    github,
    store,
    runner,
    workspace,
    project,
    events,
    ladder,
    statusMessages,
    tick,
    addedToBoard,
    now,
  };
}

const settle = async (
  h: Awaited<ReturnType<typeof harness>>,
  workflow?: string,
): Promise<RunState> => {
  const run = await h.engine.start('demo', 12, workflow ? { workflow } : {});
  return h.engine.runUntilSettled(run);
};

describe('WorkflowEngine: baseline feature workflow', () => {
  it('takes a toy issue to a green, reviewed PR without human help', async () => {
    const h = await harness();
    const run = await settle(h);
    expect(run.status).toBe('done');
    expect(run.workflow).toBe('feature');
    expect(run.pr).toEqual({
      number: 5,
      url: 'https://github.com/o/demo/pull/5',
      openedAt: '2026-10-11T18:00:00.000Z',
    });
    expect(h.workspace.pushed).toBe(1);
    expect(h.github.labelsOf(5)).toEqual([LABELS.readyToMerge]);
    expect(h.github.comments.at(-1)?.body).toMatch(/^\*\*Klar til merge\.\*\*/);
    expect(h.runner.writeTasks.map((t) => t.role)).toEqual(['implementer']);
    expect(h.runner.reviewTasks.map((t) => t.role)).toEqual(['reviewer']);
  });

  it('logs every agent turn and gate in SQLite', async () => {
    const h = await harness();
    const run = await settle(h);
    const attempts = h.store.attempts({ runId: run.id });
    expect(attempts.map((a) => [a.stage, a.attempt, a.agent, a.gate, a.passed, a.score])).toEqual([
      ['implement', 1, 'implementer', null, true, null],
      ['implement', 1, 'implementer', 'ci', true, null],
      ['implement', 1, 'reviewer', 'review', true, 9],
    ]);
    expect(attempts[0]).toMatchObject({ runner: 'codex', strategy: 'direct', phase: 'code' });
  });

  it('gives the reviewer the rubric, the diff and the author summary', async () => {
    const h = await harness();
    h.workspace.diffText = 'diff --git a/src/math.js b/src/math.js\n+export function add() {}';
    await settle(h);
    const prompt = h.runner.reviewTasks[0]?.prompt ?? '';
    expect(prompt).toContain('# Reviewer');
    expect(prompt).toContain('# Rubric\n\n# Rubric: code change');
    expect(prompt).toContain('+export function add() {}');
    expect(prompt).toContain("The author's summary: Udført af implementer.");
  });
});

describe('WorkflowEngine: escalation ladder', () => {
  const ladderWorkflow = `
stages:
  - id: implement
    agent: implementer
    gates:
      - review: { agent: reviewer, rubric: rubrics/code.md, min_score: 7 }
    on_fail:
      - retry_with_feedback x2
      - switch_strategy: plan_then_code
      - switch_runner: claude
      - switch_agent: specialist
      - escalate: human
`;

  it('climbs the ladder in the given order and ends in factory:blocked', async () => {
    const h = await harness({ workflows: { feature: ladderWorkflow }, agents: ['specialist'] });
    const failing = {
      output: { score: 3, passed: false, feedback: ['Mangler test for negative tal'] },
    };
    // Every review fails: attempts 1-3 (direct), 4 (plan + code), 5 (specialist).
    h.runner.script(...Array.from({ length: 20 }, () => failing));
    const run = await settle(h);

    expect(h.ladder()).toEqual([
      'retry_with_feedback x2',
      'retry_with_feedback x2',
      'switch_strategy: plan_then_code',
      'switch_agent: specialist',
    ]);
    expect(h.statusMessages()).toContain(
      'Runneren "claude" findes ikke. Springer "switch_runner: claude" over.',
    );
    expect(run.status).toBe('blocked');
    expect(run.reason).toBe('Eskaleret til et menneske.');
    expect(h.github.labelsOf(12)).toEqual([LABELS.blocked]);
    expect(h.github.comments.at(-1)?.body).toMatch(
      /Fabrikken er gået i stå[\s\S]*Mangler test for negative tal/,
    );
  });

  it('gives every rerun all feedback so far and switches strategy and agent', async () => {
    const h = await harness({ workflows: { feature: ladderWorkflow }, agents: ['specialist'] });
    const failing = { output: { score: 3, passed: false, feedback: ['Mangler test'] } };
    h.runner.script(...Array.from({ length: 20 }, () => failing));
    const run = await settle(h);

    const writes = h.runner.writeTasks;
    // Attempt 4 runs plan_then_code: a plan turn (no plan gates here) and then a code turn.
    expect(writes.map((t) => t.role)).toEqual([
      'implementer',
      'implementer',
      'implementer',
      'implementer',
      'implementer',
      'specialist',
    ]);
    expect(writes[2]?.prompt).toContain('[review, forsøg 1]');
    expect(writes[2]?.prompt).toContain('[review, forsøg 2]');
    expect(writes[3]?.prompt).toContain('Write an implementation plan for this issue to PLAN.md');
    expect(writes[4]?.prompt).toContain('PLAN.md on this branch holds the approved plan');
    expect(writes[5]?.prompt).toContain('[review, forsøg 4]');
    const attempts = h.store.attempts({ runId: run.id });
    expect(
      attempts.filter((a) => a.gate === null).map((a) => [a.attempt, a.strategy, a.phase, a.agent]),
    ).toEqual([
      [1, 'direct', 'code', 'implementer'],
      [2, 'direct', 'code', 'implementer'],
      [3, 'direct', 'code', 'implementer'],
      [4, 'plan_then_code', 'plan', 'implementer'],
      [4, 'plan_then_code', 'code', 'implementer'],
      [5, 'plan_then_code', 'code', 'specialist'],
    ]);
    const reviews = attempts.filter((a) => a.gate === 'review');
    expect(reviews.map((a) => a.agent)).toEqual(Array(5).fill('reviewer'));
  });

  it('treats a failed agent turn like a failed gate', async () => {
    const h = await harness({
      workflows: {
        feature:
          'stages:\n  - id: implement\n    agent: implementer\n    on_fail: [retry_with_feedback x1, escalate: human]\n',
      },
    });
    h.runner.script({ error: 'Agenten afleverede ingen slutrapport.' }, { error: 'igen' });
    const run = await settle(h);
    expect(h.ladder()).toEqual(['retry_with_feedback x1']);
    expect(run.status).toBe('blocked');
    expect(h.runner.writeTasks[1]?.prompt).toContain(
      '[agent, forsøg 1] Agenten afleverede ingen slutrapport.',
    );
  });

  it('throws QuotaExhaustedError on a usage limit and leaves the run to be retaken', async () => {
    const h = await harness();
    h.runner.script({ quota: true });
    const run = await h.engine.start('demo', 12);
    await expect(h.engine.advance(run)).rejects.toBeInstanceOf(QuotaExhaustedError);
    const saved = h.store.getRun(run.id);
    expect(saved).toMatchObject({ status: 'active', attempt: 1, ladderUsed: 0, turnDone: false });
    expect(saved?.feedback).toEqual([]);
    expect(h.workspace.commitMessages).toEqual(['WIP: demo#12 (quota)']);
    expect(h.store.attempts({ project: 'demo', issue: 12 })).toEqual([]);

    const done = await h.engine.runUntilSettled(saved ?? run);
    expect(done.status).toBe('done');
    expect(h.ladder()).toEqual([]);
  });

  it('retakes a review gate that hit the usage limit without failing it', async () => {
    const h = await harness();
    h.runner.script({}, { quota: true });
    const run = await h.engine.start('demo', 12);
    await expect(h.engine.advance(run)).rejects.toBeInstanceOf(QuotaExhaustedError);
    const saved = h.store.getRun(run.id);
    expect(saved).toMatchObject({ status: 'active', turnDone: true, gateIndex: 1, attempt: 1 });
    const done = await h.engine.runUntilSettled(saved ?? run);
    expect(done.status).toBe('done');
    expect(h.runner.writeTasks).toHaveLength(1);
    expect(h.runner.reviewTasks).toHaveLength(2);
  });

  it('feeds red CI back to the implementer with the log excerpt', async () => {
    const h = await harness();
    h.github.checkRunSequence = [
      [checkRun({ id: 7, conclusion: 'failure' })],
      [checkRun({ id: 8 })],
    ];
    h.github.jobLogs.set(
      7,
      '2026-10-11T18:00:00.0000000Z not ok 1 - clamp\n2026-10-11T18:00:00.0000000Z ##[error]Process completed with exit code 1.',
    );
    const run = await settle(h);
    expect(run.status).toBe('done');
    const retry = h.runner.writeTasks[1]?.prompt ?? '';
    expect(retry).toContain('[ci, forsøg 1] CI fejlede:');
    expect(retry).toContain('not ok 1 - clamp');
    expect(retry).toContain('##[error]Process completed with exit code 1.');
  });
});

describe('WorkflowEngine: workflow files decide the course', () => {
  it('runs plan_then_code with a plan review when only the workflow file says so', async () => {
    const h = await harness({
      workflows: {
        feature: `
stages:
  - id: implement
    agent: implementer
    strategy: plan_then_code
    gates:
      - review: { agent: reviewer, rubric: rubrics/plan.md, min_score: 7, on: plan }
      - ci
`,
      },
    });
    await writeFile(join(h.project.path, 'PLAN.md'), '1. Tilføj add() i src/math.js');
    const run = await settle(h);
    expect(run.status).toBe('done');
    expect(h.runner.tasks.map((t) => (t.readOnly ? `review:${t.role}` : t.role))).toEqual([
      'implementer',
      'review:reviewer',
      'implementer',
    ]);
    expect(h.runner.reviewTasks[0]?.prompt).toContain(
      '# The plan under review (PLAN.md)\n\n1. Tilføj add()',
    );
    expect(h.runner.writeTasks[1]?.prompt).toContain(
      'PLAN.md on this branch holds the approved plan',
    );
    expect(
      h.store.attempts({ runId: run.id }).map((a) => `${a.phase}:${a.gate ?? 'agent'}`),
    ).toEqual(['plan:agent', 'plan:review', 'code:agent', 'code:ci']);
  });

  it('runs the stages of a multi-stage workflow in order, each with its own ladder', async () => {
    const h = await harness();
    h.github.issue = { ...h.github.issue, labels: [{ name: 'bug' }] };
    const run = await settle(h);
    expect(run.workflow).toBe('bugfix');
    expect(run.status).toBe('done');
    expect(h.runner.writeTasks.map((t) => t.role)).toEqual(['reproducer', 'implementer']);
    expect(h.runner.writeTasks[1]?.prompt).toContain(
      'A test that reproduces the bug is already on the branch.',
    );
    expect(h.statusMessages()).toContain('Stage "reproduce" er godkendt. Næste stage: "fix".');
  });

  it('honours a workflow:<name> label and a project override of a baseline workflow', async () => {
    const h = await harness({
      workflows: { chore: 'stages:\n  - id: tidy\n    agent: implementer\n' },
    });
    h.github.issue = { ...h.github.issue, labels: [{ name: 'workflow:chore' }] };
    const run = await settle(h);
    expect(run.workflow).toBe('chore');
    expect(h.store.attempts({ runId: run.id }).map((a) => a.stage)).toEqual(['tidy']);
  });
});

describe('WorkflowEngine: human gates and commands', () => {
  const humanWorkflow = (mode: string) => `
stages:
  - id: implement
    agent: implementer
    gates:
      - human: ${mode}
    on_fail: [retry_with_feedback x1, escalate: human]
`;

  it('parks on a human gate, asks for a decision, and passes on /factory approve', async () => {
    const h = await harness({ workflows: { feature: humanWorkflow('always') } });
    let run = await settle(h);
    expect(run.status).toBe('waiting');
    expect(h.github.labelsOf(12)).toEqual([LABELS.needsYou]);
    expect(h.github.comments.at(-1)?.body).toContain('/factory approve #12');

    run = await h.engine.advance(run);
    expect(run.status).toBe('waiting');
    expect(h.runner.writeTasks).toHaveLength(1);

    h.store.addDecision({ project: 'demo', issue: 12, kind: 'approve', feedback: null });
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    expect(run.status).toBe('done');
    expect(h.github.labelsOf(12)).toEqual([]);
  });

  it('turns /factory reject into a failed gate with the text as feedback', async () => {
    const h = await harness({ workflows: { feature: humanWorkflow('always') } });
    let run = await settle(h);
    h.store.addDecision({
      project: 'demo',
      issue: 12,
      kind: 'reject',
      feedback: 'Brug Math.min/Math.max',
    });
    run = await h.engine.advance(run);
    expect(run.status).toBe('active');
    expect(h.ladder()).toEqual(['retry_with_feedback x1']);
    run = await h.engine.advance(run);
    expect(h.runner.writeTasks[1]?.prompt).toContain(
      '[reject, forsøg 1] nikolajjepsen afviste: Brug Math.min/Math.max',
    );
    expect(run.status).toBe('waiting');
  });

  it('passes approve_pr on an approving review from the owner after waiting began', async () => {
    const h = await harness({ workflows: { feature: humanWorkflow('approve_pr') } });
    let run = await settle(h);
    expect(h.github.comments.at(-1)?.body).toContain('Godkend https://github.com/o/demo/pull/5');
    h.tick(60_000);
    h.github.reviews = [
      {
        user: { login: 'someone-else' },
        state: 'APPROVED',
        body: '',
        submitted_at: '2026-10-11T18:01:00.000Z',
      },
    ];
    run = await h.engine.advance(run);
    expect(run.status).toBe('waiting');
    h.github.reviews.push({
      user: { login: 'nikolajjepsen' },
      state: 'APPROVED',
      body: 'Fint',
      submitted_at: '2026-10-11T18:02:00.000Z',
    });
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    expect(run.status).toBe('done');
  });

  it('stops on abort and resumes where it stopped', async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort();
    let run = await h.engine.start('demo', 12);
    run = await h.engine.runUntilSettled(run, controller.signal);
    expect(run.status).toBe('stopped');
    expect(h.runner.tasks).toHaveLength(0);

    const resumed = await h.engine.start('demo', 12);
    expect(resumed.id).toBe(run.id);
    run = await h.engine.runUntilSettled(resumed);
    expect(run.status).toBe('done');
  });

  it('stops when the agent turn is interrupted, keeping the WIP commit', async () => {
    const h = await harness();
    h.runner.script({ interrupted: true });
    const run = await settle(h);
    expect(run.status).toBe('stopped');
    expect(h.workspace.commitMessages).toEqual(['WIP: demo#12 (interrupted)']);
    expect(h.store.attempts({ runId: run.id })).toHaveLength(1);
  });

  it('uses the domain agent for a matching area: label, with its context and the project checks', async () => {
    const claude = new ScriptRunner('claude');
    const h = await harness({
      runners: [claude],
      files: {
        '.factory/agents/frontend.md':
          '---\nextends: implementer\nscope:\n  labels: [area:frontend]\ncontext: [docs/ui.md]\n---\n# Frontend',
        '.factory/agents/ui-reviewer.md':
          '---\nextends: reviewer\nscope:\n  labels: [area:frontend]\n---\n# UI-review',
        '.factory/project.yml': 'ci: pnpm check\nrunners:\n  reviewer: claude\n',
        'docs/ui.md': 'Brug designsystemet.',
      },
    });
    h.github.issue = { ...h.github.issue, labels: [{ name: 'area:frontend' }] };
    const run = await settle(h);
    expect(run.status).toBe('done');
    expect(h.runner.writeTasks.map((t) => t.role)).toEqual(['frontend']);
    const prompt = h.runner.writeTasks[0]?.prompt ?? '';
    expect(prompt).toMatch(/^# Implementer[\s\S]*# Frontend/);
    expect(prompt).toContain('# Context (docs/ui.md)\n\nBrug designsystemet.');
    expect(prompt).toContain('Run `pnpm check` before you finish.');
    // The reviewer runs on the project's runner for its role.
    expect(h.runner.reviewTasks).toEqual([]);
    expect(claude.reviewTasks.map((t) => t.role)).toEqual(['ui-reviewer']);
    expect(claude.reviewTasks[0]?.prompt).toMatch(/^# Reviewer[\s\S]*# UI-review/);
    expect(h.statusMessages()).toContain(
      'Stage "implement", code, forsøg 1: frontend (label area:frontend) på codex.',
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: 'turn', agent: 'frontend', runner: 'codex' }),
    );
    expect(h.store.attempts({ runId: run.id }).map((a) => [a.agent, a.runner, a.gate])).toEqual([
      ['frontend', 'codex', null],
      ['frontend', 'codex', 'ci'],
      ['ui-reviewer', 'claude', 'review'],
    ]);
  });

  it('falls back to the baseline agent without a matching label, and notes a missing context file', async () => {
    const h = await harness({
      files: {
        '.factory/agents/frontend.md':
          '---\nextends: implementer\nscope:\n  labels: [area:frontend]\n---\n# Frontend',
        '.factory/agents/implementer.md':
          '---\nextends: implementer\ncontext: [docs/missing.md]\n---\nBrug pnpm.',
      },
    });
    h.github.issue = { ...h.github.issue, labels: [{ name: 'area:backend' }] };
    await settle(h);
    expect(h.runner.writeTasks.map((t) => t.role)).toEqual(['implementer']);
    expect(h.statusMessages()).toContain(
      'Kontekstfilen docs/missing.md fra implementer findes ikke.',
    );
    expect(h.statusMessages()).toContain(
      'Stage "implement", code, forsøg 1: implementer (projektagent) på codex.',
    );
  });

  it('uses a /factory workflow override for a new run', async () => {
    const h = await harness();
    h.store.setWorkflowOverride('demo', 12, 'chore');
    const run = await settle(h);
    expect(run.workflow).toBe('chore');
  });
});

describe('WorkflowEngine: the idea workflow (product department)', () => {
  const brief = {
    status: 'done',
    summary: 'Tre spørgsmål om galleriet.',
    comment:
      '## Decision Brief: Galleri\n\n| 1 | Struktur | Begivenheder + album | Kun begivenheder |',
  };
  const plan = {
    status: 'done',
    summary: 'Tre vertikale snit.',
    issues: [
      { key: 'storage', title: 'Storage-adapter', body: 'B1', area: 'storage', dependsOn: [] },
      { key: 'upload', title: 'Upload', body: 'B2', area: 'area:upload', dependsOn: ['storage'] },
      {
        key: 'view',
        title: 'Visning',
        body: 'B3',
        area: 'gallery',
        dependsOn: ['storage', 'upload'],
      },
    ],
  };

  async function ideaHarness() {
    const h = await harness();
    h.github.issue = {
      ...h.github.issue,
      title: 'Jeg vil have et galleri',
      body: 'Logen skal kunne dele billeder.',
      labels: [{ name: 'idea' }],
    };
    return h;
  }

  it('turns "Jeg vil have et galleri" into an epic with sub-issues after one round of answers', async () => {
    const h = await ideaHarness();
    h.runner.script({ output: brief });

    // Analysis: the brief is posted, and the run waits for the owner's answer.
    let run = await settle(h);
    expect(run.workflow).toBe('idea');
    expect(run).toMatchObject({
      status: 'waiting',
      stageId: 'analysis',
      reason: 'venter på dit svar',
    });
    expect(h.runner.reviewTasks.map((t) => t.role)).toEqual(['analyst']);
    expect(h.runner.reviewTasks[0]?.prompt).toContain('# Template: decision-brief');
    expect(h.github.comments.map((c) => c.body)).toEqual([
      brief.comment,
      expect.stringMatching(/^\*\*Venter på dit svar\.\*\*/),
    ]);
    run = await h.engine.advance(run);
    expect(run.status).toBe('waiting');

    // The owner answers in a plain comment; the spec agent gets the brief and the answer.
    h.tick(60_000);
    h.github.repoComments.set('o/demo', [
      {
        id: 1,
        issueNumber: 12,
        author: 'nikolajjepsen',
        body: '1: kun begivenheder, resten som anbefalet',
        createdAt: h.now().toISOString(),
        url: 'u',
      },
    ]);
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    expect(run).toMatchObject({
      status: 'waiting',
      stageId: 'spec',
      reason: 'venter på, at du merger PR’en',
    });
    const specPrompt = h.runner.writeTasks[0]?.prompt ?? '';
    expect(h.runner.writeTasks.map((t) => t.role)).toEqual(['spec']);
    expect(specPrompt).toContain('# Earlier in this workflow');
    expect(specPrompt).toContain(
      '## Svar fra nikolajjepsen\n\n1: kun begivenheder, resten som anbefalet',
    );
    expect(specPrompt).toContain('# Template: spec');
    // The spec PR refers to the idea instead of closing it: the idea becomes the epic.
    expect(h.github.created[0]?.pr.body).toMatch(/^Refs #12/);

    // Not merged yet: still waiting.
    run = await h.engine.advance(run);
    expect(run.status).toBe('waiting');

    // Merged: the planner runs and the factory creates the sub-issues.
    h.github.mergedPrs.add(5);
    h.runner.script({ output: plan });
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    expect(run).toMatchObject({ status: 'done', outcome: 'planned' });
    expect(h.runner.reviewTasks.at(-1)?.prompt).toContain('PR: https://github.com/o/demo/pull/5');
    expect(
      h.github.subIssues.map((i) => [i.parent, i.number, i.title, i.labels, i.blockedBy]),
    ).toEqual([
      [12, 200, 'Storage-adapter', ['area:storage'], []],
      [12, 201, 'Upload', ['area:upload'], [9200]],
      [12, 202, 'Visning', ['area:gallery'], [9200, 9201]],
    ]);
    expect(h.addedToBoard).toEqual(['I_200', 'I_201', 'I_202']);
    expect(h.github.labelsOf(12)).toEqual([LABELS.epic]);
    expect(h.github.labelsOf(5)).toEqual([]);
    expect(h.github.comments.at(-1)?.body).toMatch(
      /^\*\*Planlagt\.\*\* Issuet er nu en epic med 3 sub-issues: #200, #201, #202\./,
    );
  });

  it('accepts every recommendation on /factory approve', async () => {
    const h = await ideaHarness();
    h.runner.script({ output: brief });
    let run = await settle(h);
    h.store.addDecision({ project: 'demo', issue: 12, kind: 'approve', feedback: null });
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    expect(run.stageId).toBe('spec');
    expect(h.runner.writeTasks[0]?.prompt).toContain(
      'nikolajjepsen godkendte alle anbefalinger uden ændringer.',
    );
  });

  it('sends an unusable plan back to the planner with the problems as feedback', async () => {
    const h = await ideaHarness();
    h.runner.script(
      { output: brief },
      {},
      { output: { ...plan, issues: [{ ...plan.issues[1], dependsOn: ['ghost'] }] } },
      { output: plan },
    );
    let run = await settle(h);
    h.store.addDecision({ project: 'demo', issue: 12, kind: 'approve', feedback: null });
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    h.github.mergedPrs.add(5);
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    expect(run.outcome).toBe('planned');
    expect(h.ladder()).toEqual(['retry_with_feedback x2']);
    expect(h.runner.reviewTasks.at(-1)?.prompt).toContain(
      '"upload" afhænger af "ghost", som ikke er et tidligere issue i listen.',
    );
    expect(h.github.subIssues).toHaveLength(3);
  });

  it('retries the spec when the owner requests changes on the spec PR', async () => {
    const h = await ideaHarness();
    h.runner.script({ output: brief });
    let run = await settle(h);
    h.store.addDecision({ project: 'demo', issue: 12, kind: 'approve', feedback: null });
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    h.tick(60_000);
    h.github.reviews = [
      {
        user: { login: 'nikolajjepsen' },
        state: 'CHANGES_REQUESTED',
        body: 'Video skal med.',
        submitted_at: h.now().toISOString(),
      },
    ];
    run = await h.engine.runUntilSettled(await h.engine.advance(run));
    expect(h.runner.writeTasks).toHaveLength(2);
    expect(h.runner.writeTasks[1]?.prompt).toContain(
      'nikolajjepsen bad om ændringer: Video skal med.',
    );
    expect(run).toMatchObject({ status: 'waiting', stageId: 'spec' });
  });
});
