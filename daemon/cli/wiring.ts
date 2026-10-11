// Composition root helpers: the only place that wires concrete runners and services to the core.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { loadFactoryConfig } from '../config/factoryConfig.js';
import { factoryHome, factoryRoot, loadProject, loadProjects } from '../config/projects.js';
import { OctokitGitHub } from '../github/github.js';
import { runIssue } from '../run/runIssue.js';
import type { Runner } from '../runner/runner.js';
import { SqliteStore } from '../store/store.js';
import { type EngineEvent, WorkflowEngine } from '../workflow/engine.js';
import { AgentLibrary, checkReferences } from '../workflow/load.js';
import type { RunState } from '../workflow/runState.js';
import { WorktreeManager } from '../workspace/workspace.js';
import { AppServerClient, type LogLevel } from '../../runners/codex/appServerClient.js';
import { CodexRunner } from '../../runners/codex/codexRunner.js';
import type { RunCommandOptions } from './commands/run.js';
import type { WorkflowValidation } from './commands/workflow.js';
import { version } from './program.js';

export const clientInfo = { name: 'ai_factory', title: 'ai-factory', version };
export const projectsFile = process.env.FACTORY_PROJECTS_FILE ?? join(factoryRoot, 'projects.yml');
export const factoryConfigFile =
  process.env.FACTORY_CONFIG_FILE ?? join(factoryRoot, 'factory.yml');
export const baselineDir = join(factoryRoot, 'agents', 'baseline');
/** Runners this build can create. M2 has only Codex; a Claude runner would be added here. */
export const KNOWN_RUNNERS = ['codex'] as const;

export const log = (level: LogLevel, message: string) => {
  if (level === 'warn' || level === 'error') process.stderr.write(`[${level}] ${message}\n`);
};

export function openStore(): SqliteStore {
  const home = factoryHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  return new SqliteStore(join(home, 'state.db'));
}

export const worktrees = () => new WorktreeManager(join(factoryHome(), 'worktrees'));

export const libraryFor = (projectPath: string) =>
  new AgentLibrary(baselineDir, join(projectPath, '.factory'));

/** Starts one shared app-server and builds the runners on top of it. */
async function withRunners<T>(
  options: Pick<RunCommandOptions, 'model' | 'network'>,
  work: (runners: Map<string, Runner>) => Promise<T>,
): Promise<T> {
  const client = new AppServerClient({ clientInfo, log });
  await client.start();
  try {
    const codex = new CodexRunner({
      client,
      log,
      ...(options.model && { model: options.model }),
      ...(options.network && { networkAccess: true }),
    });
    return await work(new Map<string, Runner>([[codex.name, codex]]));
  } finally {
    await client.stop();
  }
}

export async function runSingleRole(
  options: RunCommandOptions & { role: string },
  onEvent: Parameters<typeof runIssue>[1]['onEvent'],
  signal: AbortSignal,
) {
  const project = await loadProject(projectsFile, options.project);
  const github = await OctokitGitHub.fromGhCli();
  return withRunners(options, async (runners) => {
    const runner = runners.get('codex');
    if (!runner) throw new Error('codex runner missing');
    return runIssue(
      { github, runner, worktrees: worktrees(), agentsDir: join(factoryRoot, 'agents') },
      { project, issue: options.issue, role: options.role, signal, ...(onEvent && { onEvent }) },
    );
  });
}

export async function runWorkflow(
  options: RunCommandOptions,
  onEvent: (event: EngineEvent) => void,
  signal: AbortSignal,
): Promise<RunState> {
  const config = await loadFactoryConfig(factoryConfigFile);
  const github = await OctokitGitHub.fromGhCli();
  const store = openStore();
  try {
    return await withRunners(options, async (runners) => {
      const engine = new WorkflowEngine({
        github,
        store,
        runners,
        defaultRunner: config.default_runner,
        worktrees: worktrees(),
        project: (name) => loadProject(projectsFile, name),
        library: (project) => libraryFor(project.path),
        ownerLogin: config.owner_login,
        ci: {
          pollMs: 15_000,
          timeoutMs: config.limits.ci_timeout_minutes * 60_000,
          noChecksGraceMs: 3 * 60_000,
          now: () => new Date(),
          sleep: (ms, abort) => delay(ms, undefined, abort ? { signal: abort } : {}),
        },
        now: () => new Date(),
        newId: randomUUID,
        onEvent,
      });
      const run = await engine.start(
        options.project,
        options.issue,
        options.workflow ? { workflow: options.workflow } : {},
      );
      return engine.runUntilSettled(run, signal);
    });
  } finally {
    store.close();
  }
}

export async function validateWorkflows(): Promise<WorkflowValidation> {
  const result: WorkflowValidation = { checked: [], problems: [], skipped: [] };
  const check = async (label: string, library: AgentLibrary) => {
    try {
      const workflows = await library.loadWorkflows();
      for (const workflow of workflows.values()) {
        result.problems.push(...checkReferences(workflow, library, KNOWN_RUNNERS));
      }
      result.checked.push(`${label}: ${[...workflows.keys()].sort().join(', ')}`);
    } catch (error) {
      result.problems.push(error instanceof Error ? error.message : String(error));
    }
  };
  await check('baseline', new AgentLibrary(baselineDir));
  if (existsSync(projectsFile)) {
    for (const project of (await loadProjects(projectsFile)).values()) {
      if (!existsSync(project.path)) {
        result.skipped.push(`${project.name} (${project.path} findes ikke her)`);
        continue;
      }
      await check(project.name, libraryFor(project.path));
    }
  }
  return result;
}

export function attempts(project: string, issue: number) {
  const store = openStore();
  try {
    return Promise.resolve(store.attempts({ project, issue }));
  } finally {
    store.close();
  }
}
