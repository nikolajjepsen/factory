import type { Project } from '../config/projects.js';
import { type GitHub, type Issue, labelNames } from '../github/github.js';
import {
  buildPrompt,
  buildReviewPrompt,
  findSpecPath,
  type IssueInput,
  readOptional,
} from '../prompt/buildPrompt.js';
import { pullRequestBody } from '../run/runIssue.js';
import {
  QuotaExhaustedError,
  type RunEvent,
  type Runner,
  type RunReport,
} from '../runner/runner.js';
import type { Store } from '../store/store.js';
import { branchName, type PrepareOptions, type Workspace } from '../workspace/workspace.js';
import {
  type CiOptions,
  evaluateCi,
  evaluateHuman,
  evaluateReview,
  GateAborted,
  type GateResult,
} from './gates.js';
import type { AgentLibrary, ProjectSettings, ResolvedAgent } from './load.js';
import type { RunState } from './runState.js';
import {
  describeGate,
  describeStep,
  type Gate,
  type LadderStep,
  type Phase,
  phasesFor,
  type Stage,
  type Strategy,
  type Workflow,
} from './schema.js';
import { selectWorkflow } from './select.js';

export const LABELS = {
  readyToMerge: 'factory:ready-to-merge',
  blocked: 'factory:blocked',
  needsYou: 'factory:needs-you',
} as const;

export type EngineEvent =
  | { type: 'status'; run: RunState; message: string }
  /** An agent turn starts: the resolved agent and the runner it runs on. */
  | { type: 'turn'; run: RunState; agent: string; runner: string }
  | { type: 'agent'; run: RunState; event: RunEvent }
  | { type: 'gate'; run: RunState; gate: string; result: GateResult }
  | { type: 'ladder'; run: RunState; step: string };

export interface EngineDeps {
  github: GitHub;
  store: Store;
  runners: ReadonlyMap<string, Runner>;
  defaultRunner: string;
  worktrees: { prepare(options: PrepareOptions): Promise<Workspace> };
  project: (name: string) => Promise<Project>;
  /** Agent files, rubrics and workflows for a project. */
  library: (project: Project) => AgentLibrary;
  ownerLogin: string;
  ci: Omit<CiOptions, 'github'>;
  now: () => Date;
  newId: () => string;
  onEvent?: (event: EngineEvent) => void;
}

const PLAN_INSTRUCTIONS =
  'Write an implementation plan for this issue to PLAN.md in the repository root: the files you will change, the functions you will add or change, and the tests you will write. Do not change any other file in this step. Use `status: "done"` when the plan is written.';
const CODE_AFTER_PLAN_INSTRUCTIONS =
  'PLAN.md on this branch holds the approved plan for this issue. Implement it, then delete PLAN.md so it is not merged.';

interface Effective {
  agent: string;
  runner: string;
  strategy: Strategy;
}

interface StepContext {
  project: Project;
  issue: Issue;
  workflow: Workflow;
  stage: Stage;
  library: AgentLibrary;
  settings: ProjectSettings;
  workspace: Workspace;
  /** The stage's agent, resolved for the issue's labels. */
  agent: ResolvedAgent;
  effective: Effective;
  signal: AbortSignal | undefined;
}

/**
 * Interprets workflow files. A generic loop: for each stage, run the agent, then its gates in
 * order; the first failing gate takes the next step on the stage's escalation ladder; an empty
 * ladder blocks the issue. State is saved after every step, so a run survives restarts.
 * A turn that hits the usage limit throws QuotaExhaustedError and leaves the run untouched.
 */
export class WorkflowEngine {
  constructor(private readonly deps: EngineDeps) {}

  /** Returns the issue's open run (resuming a stopped one) or starts a new one. */
  async start(
    projectName: string,
    issueNumber: number,
    options: { workflow?: string } = {},
  ): Promise<RunState> {
    const { store, github } = this.deps;
    const open = store.findOpenRun(projectName, issueNumber);
    if (open) {
      if (open.status === 'stopped') {
        open.status = 'active';
        delete open.reason;
        this.#save(open);
        this.#status(open, 'Genoptager kørslen.');
      }
      return open;
    }
    const project = await this.deps.project(projectName);
    const issue = await github.getIssue(project.repo, issueNumber);
    if (issue.state !== 'open') throw new Error(`Issue #${String(issueNumber)} er ikke åbent.`);
    const workflows = await this.deps.library(project).loadWorkflows();
    const choice = selectWorkflow(
      issue,
      new Set(workflows.keys()),
      options.workflow ?? store.getWorkflowOverride(projectName, issueNumber),
    );
    const workflow = workflows.get(choice.workflow);
    const first = workflow?.stages[0];
    if (!workflow || !first) throw new Error(`workflow ${choice.workflow} har ingen stages`);
    const now = this.deps.now().toISOString();
    const run: RunState = {
      id: this.deps.newId(),
      project: projectName,
      issue: issueNumber,
      workflow: workflow.id,
      status: 'active',
      branch: branchName(issue.number, issue.title),
      stageIndex: 0,
      stageId: first.id,
      phase: firstPhase(first.strategy),
      attempt: 1,
      ladderIndex: 0,
      ladderUsed: 0,
      overrides: {},
      feedback: [],
      turnDone: false,
      gateIndex: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.#save(run);
    await github.removeLabel(project.repo, issueNumber, LABELS.blocked);
    this.#status(run, `Starter workflow "${workflow.id}" (${choice.reason}).`);
    return run;
  }

  /** Keeps advancing while the run is active. Stops at done, blocked, waiting or stopped. */
  async runUntilSettled(run: RunState, signal?: AbortSignal): Promise<RunState> {
    let current = run;
    while (current.status === 'active') {
      if (signal?.aborted) return this.#stop(current, 'Afbrudt.');
      current = await this.advance(current, signal);
    }
    return current;
  }

  /** Runs one step: the agent turn of the current phase (if not done yet) and then its gates. */
  async advance(run: RunState, signal?: AbortSignal): Promise<RunState> {
    if (run.status !== 'active' && run.status !== 'waiting') return run;
    const project = await this.deps.project(run.project);
    const library = this.deps.library(project);
    const workflow = (await library.loadWorkflows()).get(run.workflow);
    if (!workflow)
      return this.#block(run, project, `Workflowet "${run.workflow}" findes ikke længere.`);
    const stage = workflow.stages[run.stageIndex];
    if (!stage) return this.#finish(run, project);

    const rejection = this.deps.store.takeDecision(run.project, run.issue, 'reject');
    if (rejection) {
      await this.#leaveWaiting(run, project);
      return this.#fail(
        run,
        project,
        stage,
        library,
        'reject',
        `${this.deps.ownerLogin} afviste: ${rejection.feedback ?? '(ingen tekst)'}`,
      );
    }

    // A run parked on a human gate is checked often; ask only that gate until it moves.
    const parkedGate = stage.gates.filter((gate) => gate.on === run.phase)[run.gateIndex];
    if (run.status === 'waiting' && parkedGate?.kind === 'human') {
      const decision = await evaluateHuman(
        { github: this.deps.github, store: this.deps.store, ownerLogin: this.deps.ownerLogin },
        parkedGate,
        project.repo,
        run,
      );
      if (decision.kind === 'pending') return run;
      // Put a taken approval back, so the full pass below sees it.
      if (decision.kind === 'pass') {
        this.deps.store.addDecision({
          project: run.project,
          issue: run.issue,
          kind: 'approve',
          feedback: null,
        });
      }
    }

    const issue = await this.deps.github.getIssue(project.repo, run.issue);
    const settings = await library.projectSettings();
    const agent = await library.resolveAgent(run.overrides.agent ?? stage.agent, labelNames(issue));
    const workspace = await this.deps.worktrees.prepare({
      project: project.name,
      issue: run.issue,
      repoPath: project.path,
      branch: run.branch,
      baseBranch: await this.deps.github.getDefaultBranch(project.repo),
    });
    const ctx: StepContext = {
      project,
      issue,
      workflow,
      stage,
      library,
      settings,
      workspace,
      agent,
      effective: {
        agent: agent.name,
        runner:
          run.overrides.runner ??
          stage.runner ??
          this.#runnerFor(agent, settings) ??
          this.deps.defaultRunner,
        strategy: run.overrides.strategy ?? stage.strategy,
      },
      signal,
    };

    if (!run.turnDone) {
      const outcome = await this.#agentTurn(run, ctx);
      if (outcome) return outcome;
    }

    const gates = stage.gates.filter((gate) => gate.on === run.phase);
    for (let i = run.gateIndex; i < gates.length; i++) {
      const gate = gates[i];
      if (!gate) break;
      const started = this.deps.now().getTime();
      const reviewer =
        gate.kind === 'review' ? await this.#reviewer(gate.agent, run, ctx) : undefined;
      let result: GateResult;
      try {
        result = await this.#evaluate(gate, run, ctx, reviewer);
      } catch (error) {
        if (error instanceof GateAborted) return this.#stop(run, 'Afbrudt under en gate.');
        throw error;
      }
      this.#emit({ type: 'gate', run, gate: describeGate(gate), result });
      if (result.kind === 'pending') return this.#enterWaiting(run, project, gate);
      this.#logAttempt(run, ctx, {
        ...(reviewer && { agent: reviewer.agent.name, runner: reviewer.runner }),
        gate: gate.kind,
        score: result.score ?? null,
        passed: result.kind === 'pass',
        feedback: result.feedback ?? null,
        tokens: result.tokens?.total ?? null,
        durationMs: this.deps.now().getTime() - started,
      });
      await this.#leaveWaiting(run, project);
      if (result.kind === 'fail')
        return this.#fail(run, project, stage, library, gate.kind, result.feedback);
      run.gateIndex = i + 1;
      this.#save(run);
    }

    const phases = phasesFor(ctx.effective.strategy);
    const next = phases[phases.indexOf(run.phase) + 1];
    if (next) {
      run.phase = next;
      run.turnDone = false;
      run.gateIndex = 0;
      this.#save(run);
      this.#status(run, `Planen for "${stage.id}" er godkendt. Næste trin: kode.`);
      return run;
    }

    const nextStage = workflow.stages[run.stageIndex + 1];
    if (!nextStage) return this.#finish(run, project);
    Object.assign(run, {
      stageIndex: run.stageIndex + 1,
      stageId: nextStage.id,
      phase: firstPhase(nextStage.strategy),
      attempt: 1,
      ladderIndex: 0,
      ladderUsed: 0,
      overrides: {},
      feedback: [],
      turnDone: false,
      gateIndex: 0,
    });
    this.#save(run);
    this.#status(run, `Stage "${stage.id}" er godkendt. Næste stage: "${nextStage.id}".`);
    return run;
  }

  /** Runs the agent turn. Returns the run when the step ends here, undefined to go on to gates. */
  async #agentTurn(run: RunState, ctx: StepContext): Promise<RunState | undefined> {
    const { project, issue, stage, library, workspace, effective, agent } = ctx;
    const runner = this.deps.runners.get(effective.runner);
    if (!runner) return this.#block(run, project, `Runneren "${effective.runner}" findes ikke.`);
    const instructions = [
      ...(stage.instructions ? [stage.instructions] : []),
      ...(run.phase === 'plan' ? [PLAN_INSTRUCTIONS] : []),
      ...(run.phase === 'code' && effective.strategy === 'plan_then_code'
        ? [CODE_AFTER_PLAN_INSTRUCTIONS]
        : []),
    ];
    const prompt = buildPrompt({
      agent: agent.body,
      issue: issueInput(issue),
      ...(await this.#context(run, issue, workspace, agent)),
      ...(ctx.settings.ci && { checks: ctx.settings.ci }),
      feedback: run.feedback,
      instructions,
    });
    this.#status(
      run,
      `Stage "${stage.id}", ${run.phase}, forsøg ${String(run.attempt)}: ${agent.name} (${agent.reason}) på ${effective.runner}.`,
    );
    this.#emit({ type: 'turn', run, agent: agent.name, runner: effective.runner });
    const started = this.deps.now().getTime();
    let report: RunReport | undefined;
    const task = {
      id: `${run.project}#${String(run.issue)}`,
      role: effective.agent,
      prompt,
      workspace,
      ...(ctx.signal && { signal: ctx.signal }),
    };
    for await (const event of runner.run(task)) {
      this.#emit({ type: 'agent', run, event });
      if (event.type === 'report') report = event.report;
    }
    if (!report) throw new Error(`runner ${runner.name} ended without a report`);
    if (report.quotaExhausted) {
      // Not a failure: the run stays as it was, and the daemon waits for the quota.
      this.#save(run);
      this.#status(run, 'Kvoten slap op midt i turnen. Trinnet tages om, når der er kvote igen.');
      throw new QuotaExhaustedError(report.summary);
    }
    this.#logAttempt(run, ctx, {
      gate: null,
      score: null,
      passed: report.status === 'success',
      feedback: report.status === 'success' ? null : report.summary,
      tokens: report.tokens?.total ?? null,
      durationMs: this.deps.now().getTime() - started,
    });
    if (report.status === 'interrupted') return this.#stop(run, report.summary);
    if (report.status === 'failed')
      return this.#fail(run, project, stage, library, 'agent', report.summary);

    run.lastSummary = report.summary;
    run.turnDone = true;
    run.gateIndex = 0;
    if (report.commits.length > 0) {
      await workspace.push();
      if (!run.pr) {
        const base = await this.deps.github.getDefaultBranch(project.repo);
        const pr =
          (await this.deps.github.findOpenPullRequest(project.repo, run.branch)) ??
          (await this.deps.github.createPullRequest(project.repo, {
            head: run.branch,
            base,
            title: issue.title,
            body: pullRequestBody(issue, report, { role: effective.agent, runner: runner.name }),
          }));
        run.pr = { number: pr.number, url: pr.html_url, openedAt: this.deps.now().toISOString() };
        this.#status(run, `PR: ${pr.html_url}`);
      }
    }
    this.#save(run);
    return undefined;
  }

  /**
   * The reviewer of a review gate, resolved for the issue's labels like the stage's agent. Its
   * runner: a runner override, the reviewer's own, the project's for its role, the stage's.
   */
  async #reviewer(
    name: string,
    run: RunState,
    ctx: StepContext,
  ): Promise<{ agent: ResolvedAgent; runner: string }> {
    const agent = await ctx.library.resolveAgent(name, labelNames(ctx.issue));
    const runner =
      run.overrides.runner ??
      this.#runnerFor(agent, ctx.settings) ??
      ctx.stage.runner ??
      this.deps.defaultRunner;
    return { agent, runner };
  }

  /** The runner an agent asks for itself, or the project's runner for its role. */
  #runnerFor(agent: ResolvedAgent, settings: ProjectSettings): string | undefined {
    return agent.runner ?? settings.runners[agent.role];
  }

  async #evaluate(
    gate: Gate,
    run: RunState,
    ctx: StepContext,
    reviewer: { agent: ResolvedAgent; runner: string } | undefined,
  ): Promise<GateResult> {
    const { project, issue, library, workspace, signal } = ctx;
    switch (gate.kind) {
      case 'ci':
        if (!run.pr)
          return {
            kind: 'fail',
            feedback: 'Der er ingen PR at køre CI på, fordi der ikke er nogen ændringer.',
          };
        return evaluateCi(
          { github: this.deps.github, ...this.deps.ci },
          project.repo,
          await workspace.head(),
          signal,
        );
      case 'review': {
        if (!reviewer) throw new Error('a review gate needs its reviewer');
        const runner = this.deps.runners.get(reviewer.runner);
        if (!runner)
          return { kind: 'fail', feedback: `Runneren "${reviewer.runner}" findes ikke.` };
        const plan =
          run.phase === 'plan' ? await readOptional(workspace.path, 'PLAN.md') : undefined;
        const prompt = buildReviewPrompt({
          agent: reviewer.agent.body,
          rubric: await library.loadRubric(gate.rubric),
          issue: issueInput(issue),
          ...(await this.#context(run, issue, workspace, reviewer.agent)),
          subject:
            run.phase === 'plan'
              ? { kind: 'plan', plan: plan ?? '(PLAN.md mangler)' }
              : {
                  kind: 'diff',
                  diff: await workspace.diff(),
                  ...(run.lastSummary && { summary: run.lastSummary }),
                },
        });
        return evaluateReview(
          runner,
          {
            id: `${run.project}#${String(run.issue)}`,
            role: reviewer.agent.name,
            prompt,
            workspace,
            ...(signal && { signal }),
          },
          gate,
          (event) => {
            this.#emit({ type: 'agent', run, event });
          },
        );
      }
      case 'human':
        return evaluateHuman(
          { github: this.deps.github, store: this.deps.store, ownerLogin: this.deps.ownerLogin },
          gate,
          project.repo,
          run,
        );
    }
  }

  /** Records the failure and takes the next step on the ladder. */
  async #fail(
    run: RunState,
    project: Project,
    stage: Stage,
    library: AgentLibrary,
    source: string,
    feedback: string,
  ): Promise<RunState> {
    run.feedback.push(`[${source}, forsøg ${String(run.attempt)}] ${feedback}`);
    let chosen: LadderStep | undefined;
    while (!chosen) {
      const step = stage.onFail[run.ladderIndex];
      if (!step)
        return this.#block(run, project, `Eskaleringsstigen for "${stage.id}" er brugt op.`);
      if (step.kind === 'retry_with_feedback') {
        if (run.ladderUsed < step.times) {
          run.ladderUsed++;
          chosen = step;
        } else {
          run.ladderIndex++;
          run.ladderUsed = 0;
        }
        continue;
      }
      // Every other step is used once, then the ladder moves on.
      run.ladderIndex++;
      run.ladderUsed = 0;
      switch (step.kind) {
        case 'escalate':
          return this.#block(run, project, 'Eskaleret til et menneske.');
        case 'switch_strategy':
          run.overrides.strategy = step.strategy;
          run.phase = firstPhase(step.strategy);
          chosen = step;
          break;
        case 'switch_runner':
          if (this.deps.runners.has(step.runner)) {
            run.overrides.runner = step.runner;
            chosen = step;
          } else {
            this.#status(
              run,
              `Runneren "${step.runner}" findes ikke. Springer "${describeStep(step)}" over.`,
            );
          }
          break;
        case 'switch_agent':
          if (library.hasAgent(step.agent)) {
            run.overrides.agent = step.agent;
            chosen = step;
          } else {
            this.#status(
              run,
              `Agenten "${step.agent}" findes ikke. Springer "${describeStep(step)}" over.`,
            );
          }
          break;
      }
    }
    run.attempt++;
    run.turnDone = false;
    run.gateIndex = 0;
    run.status = 'active';
    this.#save(run);
    this.#emit({ type: 'ladder', run, step: describeStep(chosen) });
    return run;
  }

  async #block(run: RunState, project: Project, reason: string): Promise<RunState> {
    run.status = 'blocked';
    run.reason = reason;
    this.#save(run);
    const { github } = this.deps;
    await github.removeLabel(project.repo, run.issue, LABELS.needsYou);
    await github.addLabels(project.repo, run.issue, [LABELS.blocked]);
    const recent = run.feedback
      .slice(-3)
      .map((f) => `> ${f.replace(/\n/g, '\n> ')}`)
      .join('\n>\n');
    await github.createComment(
      project.repo,
      run.issue,
      [
        `**Fabrikken er gået i stå på dette issue.** ${reason}`,
        ...(recent ? ['', 'Seneste feedback:', '', recent] : []),
        '',
        `Prøv igen med \`/factory retry #${String(run.issue)}\`, eller giv feedback med \`/factory reject #${String(run.issue)} "…"\`.`,
      ].join('\n'),
    );
    this.#status(run, `Blokeret: ${reason}`);
    return run;
  }

  async #finish(run: RunState, project: Project): Promise<RunState> {
    run.status = 'done';
    this.#save(run);
    const { github } = this.deps;
    const target = run.pr?.number ?? run.issue;
    await github.addLabels(project.repo, target, [LABELS.readyToMerge]);
    await github.createComment(
      project.repo,
      target,
      `**Klar til merge.** Alle stages i workflowet "${run.workflow}" er godkendt.${run.lastSummary ? `\n\n${run.lastSummary}` : ''}`,
    );
    this.#status(run, `Færdig. ${run.pr ? `Klar til merge: ${run.pr.url}` : 'Ingen PR.'}`);
    return run;
  }

  async #enterWaiting(run: RunState, project: Project, gate: Gate): Promise<RunState> {
    if (run.status === 'waiting') return run;
    run.status = 'waiting';
    run.waitingSince = this.deps.now().toISOString();
    this.#save(run);
    const n = String(run.issue);
    const how =
      gate.kind === 'human' && gate.mode === 'approve_pr' && run.pr
        ? `Godkend ${run.pr.url} med et review, eller afvis med \`/factory reject #${n} "…"\`.`
        : `Svar med \`/factory approve #${n}\` eller \`/factory reject #${n} "…"\`.`;
    await this.deps.github.addLabels(project.repo, run.issue, [LABELS.needsYou]);
    await this.deps.github.createComment(project.repo, run.issue, `**Venter på dig.** ${how}`);
    this.#status(run, 'Venter på dig.');
    return run;
  }

  async #leaveWaiting(run: RunState, project: Project): Promise<void> {
    if (run.status !== 'waiting') return;
    run.status = 'active';
    delete run.waitingSince;
    this.#save(run);
    await this.deps.github.removeLabel(project.repo, run.issue, LABELS.needsYou);
  }

  #stop(run: RunState, reason: string): RunState {
    run.status = 'stopped';
    run.reason = reason;
    this.#save(run);
    this.#status(run, `Stoppet: ${reason}`);
    return run;
  }

  /** Spec, AGENTS.md and the agent's `context` files, read from the worktree. */
  async #context(run: RunState, issue: Issue, workspace: Workspace, agent: ResolvedAgent) {
    const specPath = findSpecPath(issue.body);
    const specText = specPath ? await readOptional(workspace.path, specPath) : undefined;
    const agentsMd = await readOptional(workspace.path, 'AGENTS.md');
    const context: { path: string; text: string }[] = [];
    for (const path of agent.context) {
      const text = await readOptional(workspace.path, path);
      if (text === undefined)
        this.#status(run, `Kontekstfilen ${path} fra ${agent.name} findes ikke.`);
      else context.push({ path, text });
    }
    return {
      ...(specPath && specText !== undefined && { spec: { path: specPath, text: specText } }),
      ...(agentsMd !== undefined && { agentsMd }),
      ...(context.length > 0 && { context }),
    };
  }

  #logAttempt(
    run: RunState,
    ctx: StepContext,
    result: {
      /** Default to the stage's agent and runner; a review gate logs its reviewer. */
      agent?: string;
      runner?: string;
      gate: string | null;
      score: number | null;
      passed: boolean;
      feedback: string | null;
      tokens: number | null;
      durationMs: number;
    },
  ): void {
    this.deps.store.logAttempt({
      runId: run.id,
      project: run.project,
      issue: run.issue,
      stage: ctx.stage.id,
      attempt: run.attempt,
      phase: run.phase,
      strategy: ctx.effective.strategy,
      ...result,
      agent: result.agent ?? ctx.effective.agent,
      runner: result.runner ?? ctx.effective.runner,
    });
  }

  #save(run: RunState): void {
    run.updatedAt = this.deps.now().toISOString();
    this.deps.store.saveRun(run);
  }

  #status(run: RunState, message: string): void {
    this.#emit({ type: 'status', run, message });
  }

  #emit(event: EngineEvent): void {
    this.deps.onEvent?.(event);
  }
}

function firstPhase(strategy: Strategy): Phase {
  return phasesFor(strategy)[0] ?? 'code';
}

function issueInput(issue: Issue): IssueInput {
  return { number: issue.number, title: issue.title, body: issue.body, url: issue.html_url };
}
