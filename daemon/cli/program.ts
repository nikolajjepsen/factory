import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };

export const version: string = pkg.version;

/** Builds the `factory` CLI. Kept free of side effects so tests can drive it in-process. */
export function createProgram(): Command {
  return new Command('factory')
    .description('ai-factory: orkestrerer AI-agenter, der bygger software i GitHub-projekter')
    .version(version, '-V, --version', 'vis versionsnummer')
    .helpOption('-h, --help', 'vis hjælp')
    .helpCommand(false);
}
