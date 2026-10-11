import type { Command } from 'commander';
import type { AttemptRecord } from '../../store/store.js';
import { parseIssueNumber } from './run.js';

export interface LogCommandDeps {
  attempts: (project: string, issue: number) => Promise<(AttemptRecord & { createdAt: string })[]>;
  stdout: (text: string) => void;
  timeZone?: string;
}

/** `2026-10-11 19:18:12` in the given (or the machine's) time zone. */
function localTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('sv-SE', timeZone ? { timeZone } : {});
}

export function formatAttempt(a: AttemptRecord & { createdAt: string }, timeZone?: string): string {
  const what = a.gate ? `gate ${a.gate}` : 'agent-turn';
  const verdict = a.passed ? 'ok' : 'fejl';
  const score = a.score === null ? '' : ` ${String(a.score)}/10`;
  const tokens = a.tokens === null ? '' : ` ${String(a.tokens)} tokens`;
  const head = `${localTime(a.createdAt, timeZone)}  ${a.stage}#${String(a.attempt)} ${a.phase}  ${a.agent}@${a.runner} (${a.strategy})  ${what}: ${verdict}${score}${tokens} ${String(Math.round(a.durationMs / 1000))}s`;
  return a.feedback && !a.passed ? `${head}\n    ${a.feedback.split('\n')[0] ?? ''}` : head;
}

export function registerLogCommand(program: Command, deps: LogCommandDeps): void {
  program
    .command('log')
    .description('vis forsøgsloggen for et issue: agent-turns og gates')
    .requiredOption('--project <navn>', 'projekt fra projects.yml')
    .requiredOption('--issue <nummer>', 'issue-nummer', parseIssueNumber)
    .action(async (options: { project: string; issue: number }) => {
      const attempts = await deps.attempts(options.project, options.issue);
      if (attempts.length === 0) deps.stdout('Ingen forsøg logget for dette issue.\n');
      for (const attempt of attempts) deps.stdout(`${formatAttempt(attempt, deps.timeZone)}\n`);
    });
}
