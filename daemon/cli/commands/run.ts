import { type Command, InvalidArgumentError } from 'commander';
import type { RunIssueResult } from '../../run/runIssue.js';
import type { RunEvent } from '../../runner/runner.js';

export interface RunCommandOptions {
  project: string;
  issue: number;
  role: string;
  model?: string;
  network?: boolean;
}

export interface RunCommandDeps {
  runIssue: (
    options: RunCommandOptions,
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ) => Promise<RunIssueResult>;
  stdout: (text: string) => void;
  /** Subscribes to Ctrl-C. Returns an unsubscribe function. */
  onInterrupt: (handler: () => void) => () => void;
  /** Ends the process at once, for a second Ctrl-C. */
  forceExit: (code: number) => void;
  setExitCode: (code: number) => void;
}

export const EXIT_INTERRUPTED = 130;

function parseIssueNumber(value: string): number {
  const number = Number(value.replace(/^#/, ''));
  if (!Number.isInteger(number) || number <= 0) {
    throw new InvalidArgumentError('skal være et issue-nummer, fx 12');
  }
  return number;
}

export function formatEvent(event: RunEvent): string | undefined {
  switch (event.type) {
    case 'started':
      return `Runner: ${event.runner}`;
    case 'message':
      return `[agent] ${event.text.trim()}`;
    case 'command':
      return `[kommando] ${event.command} → ${event.exitCode === null ? event.status : `exit ${String(event.exitCode)}`}`;
    case 'file_change':
      return `[filer] ${event.paths.join(', ')} (${event.status})`;
    case 'error':
      return `[fejl] ${event.message}`;
    case 'report':
      return undefined;
  }
}

const statusLabel = { success: 'færdig', failed: 'fejlet', interrupted: 'afbrudt' } as const;

export function formatResult(result: RunIssueResult): string {
  const { report, pullRequest } = result;
  const lines = [
    '',
    `Status: ${statusLabel[report.status]}`,
    `Opsummering: ${report.summary}`,
    `Branch: ${report.branch} (${String(report.commits.length)} commit${report.commits.length === 1 ? '' : 's'})`,
  ];
  if (report.testsRun.length > 0) lines.push(`Tests kørt: ${report.testsRun.join(', ')}`);
  if (report.tokens) lines.push(`Tokens: ${String(report.tokens.total)}`);
  if (pullRequest) lines.push(`PR: ${pullRequest.html_url}`);
  else if (report.status === 'success') lines.push('Ingen ændringer at pushe, så ingen PR.');
  return lines.join('\n');
}

export function registerRunCommand(program: Command, deps: RunCommandDeps): void {
  program
    .command('run')
    .description('kør én rolle på ét issue i et git worktree, push branchen og åbn en PR')
    .requiredOption('--project <navn>', 'projekt fra projects.yml')
    .requiredOption('--issue <nummer>', 'issue-nummer i projektets repo', parseIssueNumber)
    .option('--role <rolle>', 'agentens rolle', 'implementer')
    .option('--model <model>', 'Codex-model (standard: Codex-konfigurationen)')
    .option('--network', 'giv agenten netværksadgang i sandkassen')
    .action(async (options: RunCommandOptions, command: Command) => {
      const controller = new AbortController();
      let interrupts = 0;
      const unsubscribe = deps.onInterrupt(() => {
        interrupts++;
        if (interrupts === 1) {
          deps.stdout(
            '\nAfbryder turnen og gemmer arbejdet som WIP … (Ctrl-C igen stopper med det samme)\n',
          );
          controller.abort();
        } else {
          deps.forceExit(EXIT_INTERRUPTED);
        }
      });
      try {
        deps.stdout(`Kører ${options.role} på ${options.project}#${String(options.issue)}\n`);
        const result = await deps.runIssue(
          options,
          (event) => {
            const line = formatEvent(event);
            if (line) deps.stdout(`${line}\n`);
          },
          controller.signal,
        );
        deps.stdout(`${formatResult(result)}\n`);
        if (result.report.status === 'interrupted') deps.setExitCode(EXIT_INTERRUPTED);
        else if (result.report.status === 'failed') deps.setExitCode(1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        command.error(`factory run fejlede: ${message}`, { exitCode: 1 });
      } finally {
        unsubscribe();
      }
    });
}
