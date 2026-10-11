import type { Project } from '../config/projects.js';
import type { GitHub, Issue, PullRequest } from '../github/github.js';
import { buildPrompt, findSpecPath, loadAgentFile, readOptional } from '../prompt/buildPrompt.js';
import type { RunEvent, Runner, RunReport } from '../runner/runner.js';
import { branchName, type PrepareOptions, type Workspace } from '../workspace/workspace.js';

export interface RunIssueDeps {
  github: GitHub;
  worktrees: { prepare(options: PrepareOptions): Promise<Workspace> };
  runner: Runner;
  /** Directory holding `baseline/<role>.md`. */
  agentsDir: string;
}

export interface RunIssueOptions {
  project: Project;
  issue: number;
  role: string;
  feedback?: string[];
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
}

export interface RunIssueResult {
  report: RunReport;
  issue: Issue;
  /** Set when the branch was pushed and a pull request exists for it. */
  pullRequest?: PullRequest;
}

/**
 * Runs one role on one issue: prepares the worktree, builds the prompt, runs the agent and, on
 * success with commits, pushes the branch and opens (or reuses) a pull request.
 */
export async function runIssue(
  deps: RunIssueDeps,
  options: RunIssueOptions,
): Promise<RunIssueResult> {
  const { github, worktrees, runner, agentsDir } = deps;
  const { project, role } = options;
  const issue = await github.getIssue(project.repo, options.issue);
  if (issue.state !== 'open') throw new Error(`Issue #${String(issue.number)} er ikke åbent.`);

  const baseBranch = await github.getDefaultBranch(project.repo);
  const branch = branchName(issue.number, issue.title);
  const workspace = await worktrees.prepare({
    project: project.name,
    issue: issue.number,
    repoPath: project.path,
    branch,
    baseBranch,
  });

  const agent = await loadAgentFile(agentsDir, role);
  const specPath = findSpecPath(issue.body);
  const specText = specPath ? await readOptional(workspace.path, specPath) : undefined;
  const agentsMd = await readOptional(workspace.path, 'AGENTS.md');
  const prompt = buildPrompt({
    agent: agent.body,
    issue: { number: issue.number, title: issue.title, body: issue.body, url: issue.html_url },
    ...(specPath && specText !== undefined && { spec: { path: specPath, text: specText } }),
    ...(agentsMd !== undefined && { agentsMd }),
    ...(options.feedback && { feedback: options.feedback }),
  });

  let report: RunReport | undefined;
  const task = {
    id: `${project.name}#${String(issue.number)}`,
    role,
    prompt,
    workspace,
    ...(options.signal && { signal: options.signal }),
  };
  for await (const event of runner.run(task)) {
    options.onEvent?.(event);
    if (event.type === 'report') report = event.report;
  }
  if (!report) throw new Error(`runner ${runner.name} ended without a report`);
  if (report.status !== 'success' || report.commits.length === 0) return { report, issue };

  await workspace.push();
  const pullRequest =
    (await github.findOpenPullRequest(project.repo, branch)) ??
    (await github.createPullRequest(project.repo, {
      head: branch,
      base: baseBranch,
      title: issue.title,
      body: pullRequestBody(issue, report, { role, runner: runner.name }),
    }));
  return { report, issue, pullRequest };
}

export function pullRequestBody(
  issue: Pick<Issue, 'number'>,
  report: Pick<RunReport, 'summary' | 'testsRun'>,
  meta: { role: string; runner: string },
): string {
  const tests =
    report.testsRun.length > 0 ? report.testsRun.map((t) => `- \`${t}\``).join('\n') : '- (ingen)';
  return [
    `Closes #${String(issue.number)}`,
    '',
    '## Opsummering',
    '',
    report.summary,
    '',
    '## Tests kørt',
    '',
    tests,
    '',
    '---',
    `Lavet af ai-factory (rolle: ${meta.role}, runner: ${meta.runner}).`,
  ].join('\n');
}
