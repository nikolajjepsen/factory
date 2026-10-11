import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import type { QuotaSnapshot } from '../quota/quota.js';
import type { RunIssueResult } from '../run/runIssue.js';
import type { RunEvent, RunReport } from '../runner/runner.js';
import type { QuotaCommandSource } from './commands/quota.js';
import { EXIT_INTERRUPTED, type RunCommandOptions } from './commands/run.js';
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
  let exitCode = 0;
  const program = createProgram({
    openQuotaSource: () => Promise.resolve(fakeQuotaSource().source),
    runIssue: () => Promise.reject(new Error('runIssue not expected in this test')),
    now: () => new Date('2026-10-11T16:21:33.000Z'),
    timeZone: 'Europe/Copenhagen',
    stdout: (text) => (stdout += text),
    setExitCode: (code) => (exitCode = code),
    onInterrupt: () => () => undefined,
    forceExit: (code) => {
      throw new Error(`forceExit(${String(code)}) not expected`);
    },
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
    return { stdout, stderr, exitCode };
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

describe('factory run', () => {
  const report: RunReport = {
    status: 'success',
    summary: 'Tilføjede add().',
    testsRun: ['node --test'],
    branch: 'factory/12-tilfoej-add',
    commits: ['a1', 'b2'],
    tokens: { input: 10, output: 5, total: 15 },
  };
  const result = (overrides: Partial<RunReport> = {}, withPr = true): RunIssueResult => ({
    report: { ...report, ...overrides },
    issue: { number: 12, title: 't', body: '', html_url: 'u', state: 'open', labels: [] },
    ...(withPr && {
      pullRequest: { number: 5, html_url: 'https://github.com/o/demo/pull/5', state: 'open' },
    }),
  });

  it('passes the options on, streams events and prints the result with the PR link', async () => {
    const calls: RunCommandOptions[] = [];
    const events: RunEvent[] = [
      { type: 'started', runner: 'codex' },
      { type: 'message', text: 'Jeg kigger på koden.' },
      { type: 'command', command: 'node --test', exitCode: 0, status: 'completed' },
      { type: 'file_change', paths: ['add.js', 'add.test.js'], status: 'completed' },
      { type: 'error', message: 'reconnecting' },
    ];
    const out = await run(
      ['run', '--project', 'demo', '--issue', '#12', '--model', 'gpt-x', '--network'],
      {
        runIssue: (options, onEvent) => {
          calls.push(options);
          events.forEach(onEvent);
          return Promise.resolve(result());
        },
      },
    );
    expect(calls).toEqual([
      { project: 'demo', issue: 12, role: 'implementer', model: 'gpt-x', network: true },
    ]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(
      [
        'Kører implementer på demo#12',
        'Runner: codex',
        '[agent] Jeg kigger på koden.',
        '[kommando] node --test → exit 0',
        '[filer] add.js, add.test.js (completed)',
        '[fejl] reconnecting',
        '',
        'Status: færdig',
        'Opsummering: Tilføjede add().',
        'Branch: factory/12-tilfoej-add (2 commits)',
        'Tests kørt: node --test',
        'Tokens: 15',
        'PR: https://github.com/o/demo/pull/5',
        '',
      ].join('\n'),
    );
  });

  it('says so when a successful run changed nothing', async () => {
    const out = await run(['run', '--project', 'demo', '--issue', '12'], {
      runIssue: () => Promise.resolve(result({ commits: [] }, false)),
    });
    expect(out.stdout).toContain('Ingen ændringer at pushe, så ingen PR.');
  });

  it('exits 1 for a failed run and 130 for an interrupted one', async () => {
    const failed = await run(['run', '--project', 'demo', '--issue', '12'], {
      runIssue: () => Promise.resolve(result({ status: 'failed' }, false)),
    });
    expect(failed.exitCode).toBe(1);
    const interrupted = await run(['run', '--project', 'demo', '--issue', '12'], {
      runIssue: () => Promise.resolve(result({ status: 'interrupted' }, false)),
    });
    expect(interrupted.exitCode).toBe(EXIT_INTERRUPTED);
    expect(interrupted.stdout).toContain('Status: afbrudt');
  });

  it('aborts the run on the first Ctrl-C and exits at once on the second', async () => {
    let interrupt: (() => void) | undefined;
    const forced: number[] = [];
    let aborted = false;
    const out = await run(['run', '--project', 'demo', '--issue', '12'], {
      onInterrupt: (handler) => {
        interrupt = handler;
        return () => (interrupt = undefined);
      },
      forceExit: (code) => forced.push(code),
      runIssue: (_options, _onEvent, signal) => {
        interrupt?.();
        aborted = signal.aborted;
        interrupt?.();
        return Promise.resolve(result({ status: 'interrupted' }, false));
      },
    });
    expect(aborted).toBe(true);
    expect(forced).toEqual([EXIT_INTERRUPTED]);
    expect(out.stdout).toContain('Afbryder turnen og gemmer arbejdet som WIP');
    expect(interrupt).toBeUndefined();
  });

  it('reports setup errors in Danish with exit code 1', async () => {
    const out = await run(['run', '--project', 'nope', '--issue', '12'], {
      runIssue: () => Promise.reject(new Error('Ukendt projekt "nope".')),
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('factory run fejlede: Ukendt projekt "nope".\n');
  });

  it('validates the issue number and requires --project', async () => {
    expect((await run(['run', '--project', 'demo', '--issue', 'abc'])).stderr).toContain(
      'skal være et issue-nummer',
    );
    expect((await run(['run', '--issue', '12'])).exitCode).toBe(1);
  });
});
