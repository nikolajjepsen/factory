import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { createProgram, version } from './program.js';

const execFileAsync = promisify(execFile);
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));

function runInProcess(args: string[]): { output: string; exitCode: number | undefined } {
  let output = '';
  const program = createProgram()
    .exitOverride()
    .configureOutput({
      writeOut: (str) => (output += str),
      writeErr: (str) => (output += str),
    });
  try {
    program.parse(args, { from: 'user' });
    return { output, exitCode: undefined };
  } catch (error) {
    if (error instanceof CommanderError) return { output, exitCode: error.exitCode };
    throw error;
  }
}

describe('factory CLI', () => {
  it('reads its version from package.json', () => {
    expect(version).toBe(pkg.version);
  });

  it('prints the version for --version and -V', () => {
    for (const flag of ['--version', '-V']) {
      expect(runInProcess([flag])).toEqual({ output: `${pkg.version}\n`, exitCode: 0 });
    }
  });

  it('rejects unknown options with a non-zero exit code', () => {
    const { exitCode } = runInProcess(['--nope']);
    expect(exitCode).toBe(1);
  });

  it('prints the version when started as a real process', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import',
      'tsx',
      mainPath,
      '--version',
    ]);
    expect(stdout.trim()).toBe(pkg.version);
  });
});
