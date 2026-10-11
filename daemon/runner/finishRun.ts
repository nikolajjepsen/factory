import type { AgentReport, RunReport, RunTask, TokenUsage } from './runner.js';

/** How an agent turn ended, as seen by a runner. */
export type TurnOutcome =
  /** `output` is an AgentReport for write tasks and the `readOnly.schema` result otherwise. */
  | { kind: 'completed'; output: unknown; tokens?: TokenUsage }
  | { kind: 'interrupted'; tokens?: TokenUsage }
  | { kind: 'failed'; error: string; tokens?: TokenUsage };

/**
 * Commits whatever the agent left in the worktree and builds the RunReport. Shared by all
 * runners, so a new runner only has to produce a TurnOutcome.
 */
export async function finishRun(task: RunTask, outcome: TurnOutcome): Promise<RunReport> {
  const { workspace } = task;
  if (task.readOnly) return finishReadOnly(task, outcome);
  let status: RunReport['status'];
  let summary: string;
  let testsRun: string[] = [];
  let message: string;

  switch (outcome.kind) {
    case 'completed': {
      const report = outcome.output as AgentReport;
      testsRun = report.testsRun;
      summary = report.summary;
      if (report.status === 'done') {
        status = 'success';
        message = report.commitMessage;
      } else {
        status = 'failed';
        message = `WIP: ${task.id} (blocked)`;
      }
      break;
    }
    case 'interrupted':
      status = 'interrupted';
      summary = 'Afbrudt.';
      message = `WIP: ${task.id} (interrupted)`;
      break;
    case 'failed':
      status = 'failed';
      summary = outcome.error;
      message = `WIP: ${task.id} (failed)`;
      break;
  }

  const committed = await workspace.commitAll(message);
  if (status === 'interrupted') {
    summary += committed
      ? ' Arbejdet indtil nu er gemt som en WIP-commit på branchen.'
      : ' Agenten havde ikke ændret noget endnu, så der var intet at gemme.';
  }
  const report: RunReport = {
    status,
    summary,
    testsRun,
    branch: workspace.branch,
    commits: await workspace.commits(),
  };
  if (outcome.tokens) report.tokens = outcome.tokens;
  if (outcome.kind === 'completed') report.output = outcome.output;
  return report;
}

async function finishReadOnly(task: RunTask, outcome: TurnOutcome): Promise<RunReport> {
  const report: RunReport = {
    status: outcome.kind === 'completed' ? 'success' : outcome.kind,
    summary:
      outcome.kind === 'failed' ? outcome.error : outcome.kind === 'interrupted' ? 'Afbrudt.' : '',
    testsRun: [],
    branch: task.workspace.branch,
    commits: await task.workspace.commits(),
  };
  if (outcome.tokens) report.tokens = outcome.tokens;
  if (outcome.kind === 'completed') report.output = outcome.output;
  return report;
}
