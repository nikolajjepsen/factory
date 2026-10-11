import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryRoot } from '../config/projects.js';
import type { CreatePullRequest, GitHub, Issue, PullRequest } from '../github/github.js';
import type { RunEvent, Runner, RunReport, RunTask } from '../runner/runner.js';
import type { PrepareOptions } from '../workspace/workspace.js';
import { FakeWorkspace } from '../../test/support/fakeWorkspace.js';
import { pullRequestBody, runIssue } from './runIssue.js';

const project = { name: 'demo', repo: 'o/demo', path: '/repos/demo' };

class FakeGitHub implements GitHub {
  issue: Issue = {
    number: 12,
    title: 'Tilføj add()',
    body: 'Se specs/add.md',
    html_url: 'https://github.com/o/demo/issues/12',
    state: 'open',
    labels: [],
  };
  existingPr: PullRequest | undefined;
  created: { repo: string; pr: CreatePullRequest }[] = [];

  getIssue() {
    return Promise.resolve(this.issue);
  }
  findOpenPullRequest() {
    return Promise.resolve(this.existingPr);
  }
  createPullRequest(repo: string, pr: CreatePullRequest) {
    this.created.push({ repo, pr });
    return Promise.resolve({
      number: 5,
      html_url: 'https://github.com/o/demo/pull/5',
      state: 'open',
    });
  }
  getDefaultBranch() {
    return Promise.resolve('main');
  }
}

/** Commits once (if asked) and ends with the given report status. */
class FakeRunner implements Runner {
  readonly name = 'fake';
  tasks: RunTask[] = [];
  constructor(
    private readonly status: RunReport['status'] = 'success',
    private readonly makeCommit = true,
  ) {}
  async *run(task: RunTask): AsyncIterable<RunEvent> {
    this.tasks.push(task);
    yield { type: 'started', runner: this.name };
    if (this.makeCommit) await task.workspace.commitAll('Add add()');
    yield {
      type: 'report',
      report: {
        status: this.status,
        summary: 'Tilføjede add().',
        testsRun: ['node --test'],
        branch: task.workspace.branch,
        commits: await task.workspace.commits(),
      },
    };
  }
}

async function setup(runner = new FakeRunner()) {
  const path = await mkdtemp(join(tmpdir(), 'ai-factory-run-'));
  await mkdir(join(path, 'specs'));
  await writeFile(join(path, 'specs', 'add.md'), 'add(a, b) returnerer a + b');
  await writeFile(join(path, 'AGENTS.md'), 'Brug node:test.');
  const github = new FakeGitHub();
  const prepared: PrepareOptions[] = [];
  let workspace: FakeWorkspace | undefined;
  const worktrees = {
    prepare: (options: PrepareOptions) => {
      prepared.push(options);
      workspace = new FakeWorkspace(path, options.branch);
      return Promise.resolve(workspace);
    },
  };
  const deps = { github, runner, worktrees, agentsDir: join(factoryRoot, 'agents') };
  const ws = () => {
    if (!workspace) throw new Error('not prepared');
    return workspace;
  };
  return { deps, github, runner, prepared, ws };
}

describe('runIssue', () => {
  it('prepares a worktree on a branch named after the issue', async () => {
    const { deps, prepared } = await setup();
    await runIssue(deps, { project, issue: 12, role: 'implementer' });
    expect(prepared).toEqual([
      {
        project: 'demo',
        issue: 12,
        repoPath: '/repos/demo',
        branch: 'factory/12-tilfoej-add',
        baseBranch: 'main',
      },
    ]);
  });

  it('builds the prompt from agent file, issue, spec, AGENTS.md and feedback', async () => {
    const { deps, runner } = await setup();
    await runIssue(deps, { project, issue: 12, role: 'implementer', feedback: ['CI fejlede'] });
    const task = runner.tasks[0];
    expect(task?.id).toBe('demo#12');
    expect(task?.prompt).toContain('# Implementer');
    expect(task?.prompt).toContain('# Issue #12: Tilføj add()');
    expect(task?.prompt).toContain('# Spec (specs/add.md)\n\nadd(a, b) returnerer a + b');
    expect(task?.prompt).toContain('# Project rules (AGENTS.md)\n\nBrug node:test.');
    expect(task?.prompt).toContain('CI fejlede');
  });

  it('pushes and opens a pull request that closes the issue', async () => {
    const { deps, github, ws } = await setup();
    const events: RunEvent[] = [];
    const result = await runIssue(deps, {
      project,
      issue: 12,
      role: 'implementer',
      onEvent: (e) => events.push(e),
    });
    expect(ws().pushed).toBe(1);
    expect(github.created).toEqual([
      {
        repo: 'o/demo',
        pr: {
          head: 'factory/12-tilfoej-add',
          base: 'main',
          title: 'Tilføj add()',
          body: pullRequestBody(github.issue, result.report, {
            role: 'implementer',
            runner: 'fake',
          }),
        },
      },
    ]);
    expect(result.pullRequest?.html_url).toBe('https://github.com/o/demo/pull/5');
    expect(events.map((e) => e.type)).toEqual(['started', 'report']);
  });

  it('reuses an open pull request for the branch', async () => {
    const { deps, github } = await setup();
    github.existingPr = { number: 3, html_url: 'https://github.com/o/demo/pull/3', state: 'open' };
    const result = await runIssue(deps, { project, issue: 12, role: 'implementer' });
    expect(github.created).toEqual([]);
    expect(result.pullRequest?.number).toBe(3);
  });

  it('neither pushes nor opens a PR when the run did not succeed', async () => {
    for (const status of ['failed', 'interrupted'] as const) {
      const { deps, github, ws } = await setup(new FakeRunner(status));
      const result = await runIssue(deps, { project, issue: 12, role: 'implementer' });
      expect(result.pullRequest).toBeUndefined();
      expect(ws().pushed).toBe(0);
      expect(github.created).toEqual([]);
    }
  });

  it('opens no PR when the agent changed nothing', async () => {
    const { deps, github } = await setup(new FakeRunner('success', false));
    const result = await runIssue(deps, { project, issue: 12, role: 'implementer' });
    expect(result.report.commits).toEqual([]);
    expect(github.created).toEqual([]);
  });

  it('refuses a closed issue', async () => {
    const { deps, github } = await setup();
    github.issue = { ...github.issue, state: 'closed' };
    await expect(runIssue(deps, { project, issue: 12, role: 'implementer' })).rejects.toThrow(
      'er ikke åbent',
    );
  });
});

describe('pullRequestBody', () => {
  it('closes the issue and lists summary and tests in Danish', () => {
    expect(
      pullRequestBody(
        { number: 4 },
        { summary: 'S', testsRun: [] },
        { role: 'implementer', runner: 'codex' },
      ),
    ).toBe(
      'Closes #4\n\n## Opsummering\n\nS\n\n## Tests kørt\n\n- (ingen)\n\n---\nLavet af ai-factory (rolle: implementer, runner: codex).',
    );
  });
});
