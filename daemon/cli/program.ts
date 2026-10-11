import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { type DaemonCommandDeps, registerDaemonCommands } from './commands/daemon.js';
import { type LogCommandDeps, registerLogCommand } from './commands/log.js';
import { type QuotaCommandDeps, registerQuotaCommand } from './commands/quota.js';
import { registerRunCommand, type RunCommandDeps } from './commands/run.js';
import { registerWorkflowCommand, type WorkflowCommandDeps } from './commands/workflow.js';

export const version: string = pkg.version;

/** The domain entry points each command needs. Process I/O defaults to the real process. */
export interface CliDeps
  extends
    Pick<QuotaCommandDeps, 'openQuotaSource'>,
    Pick<RunCommandDeps, 'runIssue' | 'runWorkflow'>,
    Pick<WorkflowCommandDeps, 'validateWorkflows'>,
    Pick<LogCommandDeps, 'attempts'>,
    Pick<DaemonCommandDeps, 'runDaemon' | 'installService' | 'uninstallService' | 'apiToken'>,
    Partial<Pick<DaemonCommandDeps, 'onShutdown'>>,
    Partial<Pick<QuotaCommandDeps, 'now' | 'timeZone'>>,
    Partial<Pick<RunCommandDeps, 'onInterrupt' | 'forceExit' | 'setExitCode'>> {
  stdout?: (text: string) => void;
}

function onSigint(handler: () => void): () => void {
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

function onSigintOrSigterm(handler: () => void): () => void {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

/**
 * Builds the `factory` CLI. External I/O comes in through `deps`, so tests can drive it
 * in-process. `main.ts` wires the real implementations.
 */
export function createProgram(deps: CliDeps): Command {
  const program = new Command('factory')
    .description('ai-factory: orkestrerer AI-agenter, der bygger software i GitHub-projekter')
    .version(version, '-V, --version', 'vis versionsnummer')
    .helpOption('-h, --help', 'vis hjælp')
    .helpCommand(false);
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  registerQuotaCommand(program, {
    openQuotaSource: deps.openQuotaSource,
    now: deps.now ?? (() => new Date()),
    stdout,
    ...(deps.timeZone && { timeZone: deps.timeZone }),
  });
  registerRunCommand(program, {
    runIssue: deps.runIssue,
    runWorkflow: deps.runWorkflow,
    stdout,
    onInterrupt: deps.onInterrupt ?? onSigint,
    forceExit: deps.forceExit ?? ((code) => process.exit(code)),
    setExitCode:
      deps.setExitCode ??
      ((code) => {
        process.exitCode = code;
      }),
  });
  registerWorkflowCommand(program, { validateWorkflows: deps.validateWorkflows, stdout });
  registerLogCommand(program, {
    attempts: deps.attempts,
    stdout,
    ...(deps.timeZone && { timeZone: deps.timeZone }),
  });
  registerDaemonCommands(program, {
    runDaemon: deps.runDaemon,
    installService: deps.installService,
    uninstallService: deps.uninstallService,
    apiToken: deps.apiToken,
    onShutdown: deps.onShutdown ?? onSigintOrSigterm,
    stdout,
  });
  return program;
}
