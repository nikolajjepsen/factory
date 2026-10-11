import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { type QuotaCommandDeps, registerQuotaCommand } from './commands/quota.js';
import { registerRunCommand, type RunCommandDeps } from './commands/run.js';

export const version: string = pkg.version;

/** The I/O each command needs. Only the domain entry points are required; the rest default. */
export type CliDeps = Pick<QuotaCommandDeps, 'openQuotaSource'> &
  Pick<RunCommandDeps, 'runIssue'> &
  Partial<Omit<QuotaCommandDeps, 'openQuotaSource'>> &
  Partial<Omit<RunCommandDeps, 'runIssue'>>;

function onSigint(handler: () => void): () => void {
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
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
    now: () => new Date(),
    ...deps,
    stdout,
  });
  registerRunCommand(program, {
    onInterrupt: onSigint,
    forceExit: (code) => process.exit(code),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    ...deps,
    stdout,
  });
  return program;
}
