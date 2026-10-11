import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { type QuotaCommandDeps, registerQuotaCommand } from './commands/quota.js';

export const version: string = pkg.version;

export type CliDeps = Pick<QuotaCommandDeps, 'openQuotaSource'> & Partial<QuotaCommandDeps>;

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
  registerQuotaCommand(program, {
    now: () => new Date(),
    stdout: (text) => process.stdout.write(text),
    ...deps,
  });
  return program;
}
