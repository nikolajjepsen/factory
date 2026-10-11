import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import type { QuotaSnapshot } from '../quota/quota.js';
import type { RunIssueResult } from '../run/runIssue.js';
import type { RunEvent, RunReport } from '../runner/runner.js';
import type { AttemptRecord } from '../store/store.js';
import type { EngineEvent } from '../workflow/engine.js';
import type { RunState } from '../workflow/runState.js';
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
    runWorkflow: () => Promise.reject(new Error('runWorkflow not expected in this test')),
    validateWorkflows: () => Promise.resolve({ checked: [], problems: [], skipped: [] }),
    attempts: () => Promise.resolve([]),
    runDaemon: () => Promise.resolve(),
    installService: () => Promise.resolve('/Library/LaunchAgents/x.plist'),
    uninstallService: () => Promise.resolve(),
    onShutdown: () => () => undefined,
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

describe('factory run --role', () => {
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
      [
        'run',
        '--project',
        'demo',
        '--issue',
        '#12',
        '--role',
        'implementer',
        '--model',
        'gpt-x',
        '--network',
      ],
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
    const out = await run(['run', '--project', 'demo', '--issue', '12', '--role', 'implementer'], {
      runIssue: () => Promise.resolve(result({ commits: [] }, false)),
    });
    expect(out.stdout).toContain('Ingen ændringer at pushe, så ingen PR.');
  });

  it('exits 1 for a failed run and 130 for an interrupted one', async () => {
    const failed = await run(
      ['run', '--project', 'demo', '--issue', '12', '--role', 'implementer'],
      {
        runIssue: () => Promise.resolve(result({ status: 'failed' }, false)),
      },
    );
    expect(failed.exitCode).toBe(1);
    const interrupted = await run(
      ['run', '--project', 'demo', '--issue', '12', '--role', 'implementer'],
      {
        runIssue: () => Promise.resolve(result({ status: 'interrupted' }, false)),
      },
    );
    expect(interrupted.exitCode).toBe(EXIT_INTERRUPTED);
    expect(interrupted.stdout).toContain('Status: afbrudt');
  });

  it('aborts the run on the first Ctrl-C and exits at once on the second', async () => {
    let interrupt: (() => void) | undefined;
    const forced: number[] = [];
    let aborted = false;
    const out = await run(['run', '--project', 'demo', '--issue', '12', '--role', 'implementer'], {
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
    const out = await run(['run', '--project', 'nope', '--issue', '12', '--role', 'implementer'], {
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

describe('factory run (workflow)', () => {
  const state = (overrides: Partial<RunState> = {}): RunState => ({
    id: 'r1',
    project: 'demo',
    issue: 12,
    workflow: 'feature',
    status: 'done',
    branch: 'factory/12-x',
    stageIndex: 0,
    stageId: 'implement',
    phase: 'code',
    attempt: 2,
    ladderIndex: 0,
    ladderUsed: 1,
    overrides: {},
    feedback: [],
    turnDone: true,
    gateIndex: 2,
    pr: { number: 5, url: 'https://github.com/o/demo/pull/5' },
    createdAt: '2026-10-11T18:00:00.000Z',
    updatedAt: '2026-10-11T18:00:00.000Z',
    ...overrides,
  });

  it('runs the workflow and prints status, agent, gate and ladder events', async () => {
    const options: RunCommandOptions[] = [];
    const out = await run(['run', '--project', 'demo', '--issue', '12', '--workflow', 'chore'], {
      runWorkflow: (o, onEvent) => {
        options.push(o);
        const r = state();
        const events: EngineEvent[] = [
          { type: 'status', run: r, message: 'Starter workflow "chore" (/factory workflow).' },
          {
            type: 'agent',
            run: r,
            event: { type: 'command', command: 'npm test', exitCode: 1, status: 'completed' },
          },
          {
            type: 'gate',
            run: r,
            gate: 'review (reviewer, min 7)',
            result: { kind: 'fail', score: 5, feedback: '- Mangler test\n- Navngivning' },
          },
          { type: 'ladder', run: r, step: 'retry_with_feedback x3' },
          { type: 'gate', run: r, gate: 'ci', result: { kind: 'pass' } },
          { type: 'gate', run: r, gate: 'human: always', result: { kind: 'pending' } },
        ];
        events.forEach(onEvent);
        return Promise.resolve(r);
      },
    });
    expect(options).toEqual([{ project: 'demo', issue: 12, workflow: 'chore' }]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(
      [
        'Kører workflow på demo#12',
        '» Starter workflow "chore" (/factory workflow).',
        '[kommando] npm test → exit 1',
        '[gate] review (reviewer, min 7): fejlet (5/10)',
        '    - Mangler test',
        '    - Navngivning',
        '[stige] retry_with_feedback x3',
        '[gate] ci: bestået',
        '[gate] human: always: venter',
        '',
        'Status: færdig, klar til merge',
        'Workflow: feature',
        'Branch: factory/12-x',
        'PR: https://github.com/o/demo/pull/5',
        '',
      ].join('\n'),
    );
  });

  it('exits 1 when blocked and 130 when stopped, and says how to continue', async () => {
    const blocked = await run(['run', '--project', 'demo', '--issue', '12'], {
      runWorkflow: () =>
        Promise.resolve(state({ status: 'blocked', reason: 'Eskaleret til et menneske.' })),
    });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stdout).toContain('Årsag: Eskaleret til et menneske.');
    const stopped = await run(['run', '--project', 'demo', '--issue', '12'], {
      runWorkflow: () => Promise.resolve(state({ status: 'stopped' })),
    });
    expect(stopped.exitCode).toBe(EXIT_INTERRUPTED);
    expect(stopped.stdout).toContain('Fortsæt med: factory run --project demo --issue 12');
  });
});

describe('factory workflow validate', () => {
  it('lists what was checked and skipped, and exits 0 when all is valid', async () => {
    const out = await run(['workflow', 'validate'], {
      validateWorkflows: () =>
        Promise.resolve({
          checked: ['baseline: bugfix, chore, feature'],
          problems: [],
          skipped: ['loge-app (/x findes ikke her)'],
        }),
    });
    expect(out).toEqual({
      stdout:
        '✓ baseline: bugfix, chore, feature\n- sprunget over: loge-app (/x findes ikke her)\n',
      stderr: '',
      exitCode: 0,
    });
  });

  it('prints every problem and exits 1', async () => {
    const out = await run(['workflow', 'validate'], {
      validateWorkflows: () =>
        Promise.resolve({
          checked: [],
          problems: ['a.yml: unknown agent "x"', 'b.yml is invalid'],
          skipped: [],
        }),
    });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('✖ a.yml: unknown agent "x"\n✖ b.yml is invalid\n');
  });
});

describe('factory log', () => {
  it('prints one line per attempt with the first feedback line for failures', async () => {
    const attempt: AttemptRecord & { createdAt: string } = {
      runId: 'r1',
      project: 'demo',
      issue: 12,
      stage: 'implement',
      attempt: 1,
      phase: 'code',
      agent: 'reviewer',
      runner: 'codex',
      strategy: 'direct',
      gate: 'review',
      score: 5,
      passed: false,
      feedback: 'Review gav 5/10 (kræver 7).\n- Mangler test',
      tokens: 1200,
      durationMs: 31_400,
      createdAt: '2026-10-11T18:05:00.000Z',
    };
    const out = await run(['log', '--project', 'demo', '--issue', '12'], {
      attempts: () => Promise.resolve([attempt]),
    });
    expect(out.stdout).toBe(
      '2026-10-11 20:05:00  implement#1 code  reviewer@codex (direct)  gate review: fejl 5/10 1200 tokens 31s\n    Review gav 5/10 (kræver 7).\n',
    );
  });

  it('says so when nothing is logged', async () => {
    expect((await run(['log', '--project', 'demo', '--issue', '12'])).stdout).toBe(
      'Ingen forsøg logget for dette issue.\n',
    );
  });
});

describe('factory daemon and services', () => {
  it('runs the daemon until shutdown and passes --once on', async () => {
    const calls: boolean[] = [];
    let shutdown: (() => void) | undefined;
    const out = await run(['daemon'], {
      onShutdown: (handler) => {
        shutdown = handler;
        return () => {
          shutdown = undefined;
        };
      },
      runDaemon: (options, signal) => {
        calls.push(options.once);
        shutdown?.();
        expect(signal.aborted).toBe(true);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([false]);
    expect(out.stdout).toContain('Stopper daemonen');
    expect(shutdown).toBeUndefined();
    await run(['daemon', '--once'], {
      runDaemon: (options) => (calls.push(options.once), Promise.resolve()),
    });
    expect(calls).toEqual([false, true]);
  });

  it('installs and uninstalls the launchd agent', async () => {
    expect((await run(['install-service'])).stdout).toBe(
      'Installeret og startet: /Library/LaunchAgents/x.plist\nLog: ~/.ai-factory/logs/daemon.log\n',
    );
    expect((await run(['uninstall-service'])).stdout).toBe(
      'launchd-agenten er stoppet og fjernet.\n',
    );
  });
});
