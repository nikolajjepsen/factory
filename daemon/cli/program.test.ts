import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import type { QuotaSnapshot } from '../quota/quota.js';
import type { QuotaCommandSource } from './commands/quota.js';
import { type CliDeps, createProgram, version } from './program.js';

const execFileAsync = promisify(execFile);
const mainPath = fileURLToPath(new URL('./main.ts', import.meta.url));

const snapshot: QuotaSnapshot = {
  fiveHour: { usedPercent: 3, resetsAt: '2026-10-11T20:30:24.000Z' },
  weekly: { usedPercent: 0, resetsAt: '2026-10-18T15:30:24.000Z' },
  fetchedAt: '2026-10-11T16:21:33.000Z',
};

function fakeQuotaSource(overrides: Partial<QuotaCommandSource> = {}) {
  const calls = { closed: 0 };
  const source: QuotaCommandSource = {
    read: () => Promise.resolve(snapshot),
    readRaw: () => Promise.resolve({ raw: true }),
    subscribe: () => () => undefined,
    close: () => {
      calls.closed++;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { source, calls };
}

/** Commander copies output settings to subcommands at creation, so configure all of them. */
function configureAll(command: Command, configure: (c: Command) => void): void {
  configure(command);
  for (const sub of command.commands) configureAll(sub, configure);
}

async function run(args: string[], deps: Partial<CliDeps> = {}) {
  let stdout = '';
  let stderr = '';
  const program = createProgram({
    openQuotaSource: () => Promise.resolve(fakeQuotaSource().source),
    now: () => new Date('2026-10-11T16:21:33.000Z'),
    timeZone: 'Europe/Copenhagen',
    stdout: (text) => (stdout += text),
    ...deps,
  });
  configureAll(program, (c) =>
    c.exitOverride().configureOutput({
      writeOut: (str) => (stdout += str),
      writeErr: (str) => (stderr += str),
    }),
  );
  try {
    await program.parseAsync(args, { from: 'user' });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (error instanceof CommanderError) return { stdout, stderr, exitCode: error.exitCode };
    throw error;
  }
}

describe('factory --version', () => {
  it('reads its version from package.json', () => {
    expect(version).toBe(pkg.version);
  });

  it('prints the version for --version and -V', async () => {
    for (const flag of ['--version', '-V']) {
      expect(await run([flag])).toEqual({ stdout: `${pkg.version}\n`, stderr: '', exitCode: 0 });
    }
  });

  it('rejects unknown options with a non-zero exit code', async () => {
    expect((await run(['--nope'])).exitCode).toBe(1);
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

describe('factory quota', () => {
  it('prints both windows in Danish with local reset times, and closes the source', async () => {
    const { source, calls } = fakeQuotaSource();
    const result = await run(['quota'], { openQuotaSource: () => Promise.resolve(source) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        'Codex-kvote (hentet 11. okt. 2026 kl. 18.21)',
        '5 timer    97 % tilbage   nulstilles i dag kl. 22.30 (om 4 t 9 min)',
        'Uge       100 % tilbage   nulstilles søn. 18. okt. kl. 17.30 (om 6 d 23 t)',
        '',
      ].join('\n'),
    );
    expect(calls.closed).toBe(1);
  });

  it('prints the normalized snapshot with --json', async () => {
    const result = await run(['quota', '--json']);
    expect(JSON.parse(result.stdout)).toEqual(snapshot);
  });

  it('prints the raw source answer with --raw', async () => {
    const result = await run(['quota', '--raw']);
    expect(JSON.parse(result.stdout)).toEqual({ raw: true });
  });

  it('fails with a Danish message and exit code 1 when Codex cannot be reached', async () => {
    const result = await run(['quota'], {
      openQuotaSource: () => Promise.reject(new Error('codex app-server could not start: ENOENT')),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'Kunne ikke læse kvoten fra Codex: codex app-server could not start: ENOENT\n',
    );
  });

  it('closes the source when reading fails', async () => {
    const { source, calls } = fakeQuotaSource({
      read: () => Promise.reject(new Error('bad payload')),
    });
    const result = await run(['quota'], { openQuotaSource: () => Promise.resolve(source) });
    expect(result.exitCode).toBe(1);
    expect(calls.closed).toBe(1);
  });
});
