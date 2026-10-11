import { describe, expect, it } from 'vitest';
import { checkRun, FakeGitHub } from '../../test/support/fakeGitHub.js';
import { type CiOptions, evaluateCi, excerptLog, GateAborted } from './gates.js';

function ci(github: FakeGitHub, overrides: Partial<CiOptions> = {}) {
  let clock = 0;
  const options: CiOptions = {
    github,
    pollMs: 15_000,
    timeoutMs: 30 * 60_000,
    noChecksGraceMs: 3 * 60_000,
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { options, elapsed: () => clock };
}

describe('evaluateCi', () => {
  it('waits for checks to appear and finish, then passes', async () => {
    const github = new FakeGitHub();
    github.checkRunSequence = [
      [],
      [checkRun({ status: 'in_progress', conclusion: null })],
      [checkRun()],
    ];
    const { options, elapsed } = ci(github);
    expect(await evaluateCi(options, 'o/demo', 'abc')).toEqual({ kind: 'pass' });
    expect(elapsed()).toBe(30_000);
  });

  it('accepts neutral and skipped checks and passing commit statuses', async () => {
    const github = new FakeGitHub();
    github.checkRunSequence = [
      [checkRun({ conclusion: 'neutral' }), checkRun({ id: 2, conclusion: 'skipped' })],
    ];
    github.statuses = [
      { context: 'vercel', state: 'success', description: null, target_url: null },
    ];
    expect(await evaluateCi(ci(github).options, 'o/demo', 'abc')).toEqual({ kind: 'pass' });
  });

  it('fails with each failed check and the Actions log excerpt', async () => {
    const github = new FakeGitHub();
    github.checkRunSequence = [
      [checkRun({ id: 7, name: 'test', conclusion: 'failure' }), checkRun({ id: 8, name: 'lint' })],
    ];
    github.statuses = [
      { context: 'deploy', state: 'error', description: 'build crashed', target_url: null },
    ];
    github.jobLogs.set(7, 'line 1\n##[error]boom');
    const result = await evaluateCi(ci(github).options, 'o/demo', 'abc');
    expect(result).toEqual({
      kind: 'fail',
      feedback:
        'CI fejlede:\n- test: failure (https://github.com/o/demo/runs/1)\n\n```\nline 1\n##[error]boom\n```\n- deploy: error – build crashed',
    });
  });

  it('waits on pending commit statuses even when check runs are done', async () => {
    const github = new FakeGitHub();
    github.checkRunSequence = [[checkRun()]];
    github.statuses = [{ context: 'ext', state: 'pending', description: null, target_url: null }];
    const { options } = ci(github, { timeoutMs: 60_000 });
    expect(await evaluateCi(options, 'o/demo', 'abc')).toEqual({
      kind: 'fail',
      feedback: 'CI blev ikke færdig inden for 1 min.',
    });
  });

  it('fails when no checks show up within the grace period', async () => {
    const github = new FakeGitHub();
    const result = await evaluateCi(ci(github).options, 'o/demo', 'abcdef123');
    expect(result).toEqual({
      kind: 'fail',
      feedback: 'Ingen CI-tjek blev rapporteret for abcdef1 inden for 3 min.',
    });
  });

  it('aborts when the signal fires', async () => {
    const github = new FakeGitHub();
    const controller = new AbortController();
    controller.abort();
    await expect(
      evaluateCi(ci(github).options, 'o/demo', 'abc', controller.signal),
    ).rejects.toBeInstanceOf(GateAborted);
  });
});

describe('excerptLog', () => {
  it('strips timestamps and colour codes and keeps error lines at the end', () => {
    const log = [
      '2026-10-11T18:00:00.1234567Z \u001b[36mRun npm test\u001b[0m',
      '2026-10-11T18:00:01.0000000Z ##[error]Process completed with exit code 1.',
      '2026-10-11T18:00:01.5000000Z Post job cleanup.',
    ].join('\n');
    expect(excerptLog(log)).toBe(
      'Run npm test\nPost job cleanup.\n##[error]Process completed with exit code 1.',
    );
  });

  it('keeps only the tail of long logs', () => {
    const log = Array.from({ length: 500 }, (_, i) => `line ${String(i)} ${'x'.repeat(80)}`).join(
      '\n',
    );
    const excerpt = excerptLog(log);
    expect(excerpt.startsWith('…\n')).toBe(true);
    expect(excerpt).toContain('line 499');
    expect(excerpt).not.toContain('line 100 ');
  });
});
