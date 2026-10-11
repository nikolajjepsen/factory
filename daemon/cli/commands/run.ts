import { type Command, InvalidArgumentError } from 'commander';
import type { RunIssueResult } from '../../run/runIssue.js';
import { QuotaExhaustedError, type RunEvent } from '../../runner/runner.js';
import type { EngineEvent } from '../../workflow/engine.js';
import type { RunState } from '../../workflow/runState.js';

export interface RunCommandOptions {
  project: string;
  issue: number;
  /** Set: run one turn with this role (M2). Unset: run the issue's workflow. */
  role?: string;
  workflow?: string;
  model?: string;
  network?: boolean;
}

export interface RunCommandDeps {
  runIssue: (
    options: RunCommandOptions & { role: string },
    onEvent: (event: RunEvent) => void,
    signal: AbortSignal,
  ) => Promise<RunIssueResult>;
  runWorkflow: (
    options: RunCommandOptions,
    onEvent: (event: EngineEvent) => void,
    signal: AbortSignal,
  ) => Promise<RunState>;
  stdout: (text: string) => void;
  /** Subscribes to Ctrl-C. Returns an unsubscribe function. */
  onInterrupt: (handler: () => void) => () => void;
  /** Ends the process at once, for a second Ctrl-C. */
  forceExit: (code: number) => void;
  setExitCode: (code: number) => void;
}

export const EXIT_INTERRUPTED = 130;

export function parseIssueNumber(value: string): number {
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

const indent = (text: string) => text.replace(/\n/g, '\n    ');

export function formatEngineEvent(event: EngineEvent): string | undefined {
  switch (event.type) {
    case 'status':
      return `» ${event.message}`;
    case 'agent':
      return formatEvent(event.event);
    case 'ladder':
      return `[stige] ${event.step}`;
    case 'gate': {
      const { result } = event;
      if (result.kind === 'pending') return `[gate] ${event.gate}: venter`;
      const score = result.score === undefined ? '' : ` (${String(result.score)}/10)`;
      const verdict = result.kind === 'pass' ? 'bestået' : 'fejlet';
      const feedback = result.feedback ? `\n    ${indent(result.feedback)}` : '';
      return `[gate] ${event.gate}: ${verdict}${score}${feedback}`;
    }
  }
}

const runStatusLabel: Record<RunState['status'], string> = {
  active: 'i gang',
  waiting: 'venter på dig',
  stopped: 'stoppet',
  done: 'færdig, klar til merge',
  blocked: 'blokeret',
};

export function formatRunState(run: RunState): string {
  const lines = [
    '',
    `Status: ${runStatusLabel[run.status]}`,
    `Workflow: ${run.workflow}`,
    `Branch: ${run.branch}`,
  ];
  if (run.reason) lines.push(`Årsag: ${run.reason}`);
  if (run.pr) lines.push(`PR: ${run.pr.url}`);
  if (run.status === 'stopped')
    lines.push(`Fortsæt med: factory run --project ${run.project} --issue ${String(run.issue)}`);
  return lines.join('\n');
}

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
    .description('kør issuets workflow (eller én rolle med --role) i et git worktree og åbn en PR')
    .requiredOption('--project <navn>', 'projekt fra projects.yml')
    .requiredOption('--issue <nummer>', 'issue-nummer i projektets repo', parseIssueNumber)
    .option('--workflow <navn>', 'vælg workflow i stedet for at udlede det af issuet')
    .option('--role <rolle>', 'kør kun én turn med denne rolle, uden workflow')
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
      const print = (line: string | undefined) => {
        if (line) deps.stdout(`${line}\n`);
      };
      try {
        const target = `${options.project}#${String(options.issue)}`;
        if (options.role) {
          deps.stdout(`Kører ${options.role} på ${target}\n`);
          const result = await deps.runIssue(
            { ...options, role: options.role },
            (event) => {
              print(formatEvent(event));
            },
            controller.signal,
          );
          deps.stdout(`${formatResult(result)}\n`);
          if (result.report.status === 'interrupted') deps.setExitCode(EXIT_INTERRUPTED);
          else if (result.report.status === 'failed') deps.setExitCode(1);
          return;
        }
        deps.stdout(`Kører workflow på ${target}\n`);
        const run = await deps.runWorkflow(
          options,
          (event) => {
            print(formatEngineEvent(event));
          },
          controller.signal,
        );
        deps.stdout(`${formatRunState(run)}\n`);
        if (run.status === 'stopped') deps.setExitCode(EXIT_INTERRUPTED);
        else if (run.status === 'blocked') deps.setExitCode(1);
      } catch (error) {
        if (error instanceof QuotaExhaustedError) {
          command.error(
            `Codex-kvoten er brugt op (${error.message}). Kørslen er gemt. Kør samme kommando igen, når kvoten er nulstillet; se \`factory quota\`.`,
            { exitCode: 1 },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        command.error(`factory run fejlede: ${message}`, { exitCode: 1 });
      } finally {
        unsubscribe();
      }
    });
}
