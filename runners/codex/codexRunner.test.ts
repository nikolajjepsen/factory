import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunReport, RunTask } from '../../daemon/runner/runner.js';
import {
  codexResponder,
  type FakeConnection,
  fakeConnections,
  type SentMessage,
} from '../../test/support/fakeConnection.js';
import { FakeWorkspace } from '../../test/support/fakeWorkspace.js';
import { loadTurnFixture, type TurnFixture } from '../../test/support/turnFixture.js';
import { AppServerClient } from './appServerClient.js';
import { CodexRunner, type CodexRunnerOptions } from './codexRunner.js';

const completed = loadTurnFixture('turn-completed.jsonl');
const interrupted = loadTurnFixture('turn-interrupted.jsonl');
const clientInfo = { name: 'ai_factory', title: null, version: '0.0.0-test' };

const validReport = {
  status: 'done',
  summary: 'Oprettede hello.txt.',
  testsRun: ['cat hello.txt'],
  commitMessage: 'Add hello.txt',
};

type Notification = TurnFixture['notifications'][number];

/** Replaces the text of the recorded final answer. The recording used a different schema. */
function withFinalAnswer(notifications: Notification[], text: string): Notification[] {
  return JSON.parse(
    JSON.stringify(notifications).replace(
      /("text":")((?:[^"\\]|\\.)*)(","phase":"final_answer")/g,
      (_m, open: string, _old: string, close: string) =>
        `${open}${JSON.stringify(text).slice(1, -1)}${close}`,
    ),
  ) as Notification[];
}

interface ReplayOptions {
  notifications?: Notification[];
  /** Stop replaying before the first notification this returns true for; the rest follow turn/interrupt. */
  pauseAt?: (n: Notification) => boolean;
  /** Sent after turn/interrupt instead of the paused remainder. */
  afterInterrupt?: Notification[];
}

function replay(fixture: TurnFixture, options: ReplayOptions = {}) {
  const notifications = options.notifications ?? fixture.notifications;
  const pause = options.pauseAt ? notifications.findIndex(options.pauseAt) : -1;
  const before = pause >= 0 ? notifications.slice(0, pause) : notifications;
  const after = options.afterInterrupt ?? (pause >= 0 ? notifications.slice(pause) : []);
  const emitAll = (conn: FakeConnection, list: Notification[]) => {
    queueMicrotask(() => {
      for (const n of list) conn.emit(n);
    });
  };
  return (message: SentMessage, conn: FakeConnection) => {
    codexResponder()(message, conn);
    if (message.method === 'thread/start') conn.reply(message.id, fixture.threadStartResult);
    if (message.method === 'turn/start') {
      conn.reply(message.id, fixture.turnStartResult);
      emitAll(conn, before);
    }
    if (message.method === 'turn/interrupt') {
      conn.reply(message.id, {});
      emitAll(conn, after);
    }
  };
}

async function setup(
  responder: ReturnType<typeof replay>,
  options: Partial<CodexRunnerOptions> = {},
) {
  const fakes = fakeConnections(responder);
  const client = new AppServerClient({ clientInfo, connect: fakes.connect });
  await client.start();
  const runner = new CodexRunner({ client, ...options });
  const workspace = new FakeWorkspace();
  return { fakes, client, runner, workspace };
}

async function runToEnd(runner: CodexRunner, task: RunTask) {
  const events: RunEvent[] = [];
  for await (const event of runner.run(task)) events.push(event);
  const last = events.at(-1);
  if (last?.type !== 'report') throw new Error('last event was not a report');
  return { events, report: last.report };
}

const taskFor = (workspace: FakeWorkspace, signal?: AbortSignal): RunTask => ({
  id: 'demo#1',
  role: 'implementer',
  prompt: 'Opret hello.txt',
  workspace,
  ...(signal && { signal }),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CodexRunner on a completed turn', () => {
  it('starts a sandboxed thread in the worktree and asks for the report schema', async () => {
    const { runner, workspace, fakes } = await setup(
      replay(completed, {
        notifications: withFinalAnswer(completed.notifications, JSON.stringify(validReport)),
      }),
      { model: 'gpt-test' },
    );
    await runToEnd(runner, taskFor(workspace));
    const sent = fakes.latest().sent;
    expect(sent.find((m) => m.method === 'thread/start')?.params).toEqual({
      cwd: workspace.path,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      ephemeral: true,
      model: 'gpt-test',
    });
    const turnStart = sent.find((m) => m.method === 'turn/start')?.params as Record<
      string,
      unknown
    >;
    expect(turnStart.input).toEqual([{ type: 'text', text: 'Opret hello.txt', text_elements: [] }]);
    expect(turnStart.sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      writableRoots: [workspace.path],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(turnStart.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['status', 'summary', 'testsRun', 'commitMessage'],
    });
    expect(turnStart.outputSchema).not.toHaveProperty('$schema');
  });

  it('streams commentary and commands, then commits and reports success with tokens', async () => {
    const { runner, workspace } = await setup(
      replay(completed, {
        notifications: withFinalAnswer(completed.notifications, JSON.stringify(validReport)),
      }),
    );
    const { events, report } = await runToEnd(runner, taskFor(workspace));
    expect(events[0]).toEqual({ type: 'started', runner: 'codex' });
    expect(events.filter((e) => e.type === 'message').length).toBeGreaterThan(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'command',
        command: "/bin/zsh -lc 'cat hello.txt'",
        exitCode: 0,
      }),
    );
    expect(workspace.commitMessages).toEqual(['Add hello.txt']);
    expect(report).toEqual<RunReport>({
      status: 'success',
      summary: 'Oprettede hello.txt.',
      testsRun: ['cat hello.txt'],
      branch: workspace.branch,
      commits: ['sha1'],
      tokens: { input: 32432, output: 225, total: 32657 },
    });
  });

  it('fails when the final answer does not match the report schema (as recorded)', async () => {
    const { runner, workspace } = await setup(replay(completed));
    const { report } = await runToEnd(runner, taskFor(workspace));
    expect(report.status).toBe('failed');
    expect(report.summary).toMatch(/^Agentens slutrapport har forkert form/);
    expect(workspace.commitMessages).toEqual(['WIP: demo#1 (failed)']);
  });

  it('fails when the final answer is not JSON', async () => {
    const { runner, workspace } = await setup(
      replay(completed, { notifications: withFinalAnswer(completed.notifications, 'all done!') }),
    );
    const { report } = await runToEnd(runner, taskFor(workspace));
    expect(report.summary).toBe('Agentens slutrapport er ikke JSON: all done!');
  });

  it('ignores notifications for other threads', async () => {
    const other = completed.notifications.map<Notification>(
      (n) =>
        JSON.parse(
          JSON.stringify(n).replaceAll('01a12bd2-00cf-7010-94a4-27d0d82d5f7e', 'other-thread'),
        ) as Notification,
    );
    const ownTurnCompleted = completed.notifications.filter((n) => n.method === 'turn/completed');
    const { runner, workspace } = await setup(
      replay(completed, { notifications: other, afterInterrupt: ownTurnCompleted }),
      { turnTimeoutMs: 1_000 },
    );
    vi.useFakeTimers();
    const result = runToEnd(runner, taskFor(workspace));
    await vi.advanceTimersByTimeAsync(1_000);
    const { events, report } = await result;
    expect(events.filter((e) => e.type === 'command')).toEqual([]);
    expect(report.status).toBe('failed');
  });
});

describe('CodexRunner interrupts', () => {
  const pauseAt = (n: Notification) =>
    n.method === 'item/started' && JSON.stringify(n.params).includes('"commandExecution"');

  it('sends turn/interrupt on abort and leaves a WIP commit', async () => {
    const { runner, workspace, fakes } = await setup(replay(interrupted, { pauseAt }));
    const controller = new AbortController();
    const events: RunEvent[] = [];
    for await (const event of runner.run(taskFor(workspace, controller.signal))) {
      events.push(event);
      if (event.type === 'message') controller.abort();
    }
    const interruptCall = fakes.latest().sent.find((m) => m.method === 'turn/interrupt');
    expect(interruptCall?.params).toEqual({
      threadId: '01a12bd2-598a-7c61-9c21-6b3938741bb4',
      turnId: '01a12bd2-59dd-71e2-bcbd-d65f0d9794d9',
    });
    const report = events.at(-1);
    expect(report).toMatchObject({
      type: 'report',
      report: { status: 'interrupted', commits: ['sha1'] },
    });
    expect(workspace.commitMessages).toEqual(['WIP: demo#1 (interrupted)']);
  });

  it('does not start a thread when already aborted', async () => {
    const { runner, workspace, fakes } = await setup(replay(interrupted));
    const controller = new AbortController();
    controller.abort();
    const { report } = await runToEnd(runner, taskFor(workspace, controller.signal));
    expect(report.status).toBe('interrupted');
    expect(fakes.latest().sent.some((m) => m.method === 'thread/start')).toBe(false);
  });

  it('interrupts a turn that runs past the timeout and reports it as failed', async () => {
    const { runner, workspace, fakes } = await setup(replay(interrupted, { pauseAt }), {
      turnTimeoutMs: 120_000,
    });
    vi.useFakeTimers();
    const result = runToEnd(runner, taskFor(workspace));
    await vi.advanceTimersByTimeAsync(120_000);
    const { report } = await result;
    expect(fakes.latest().sent.some((m) => m.method === 'turn/interrupt')).toBe(true);
    expect(report).toMatchObject({
      status: 'failed',
      summary: 'Turnen tog mere end 2 min og blev afbrudt.',
    });
  });
});

describe('CodexRunner failures', () => {
  it('reports a failed turn with its error message', async () => {
    const failed = completed.notifications.map((n) =>
      n.method === 'turn/completed'
        ? {
            ...n,
            params: {
              threadId: '01a12bd2-00cf-7010-94a4-27d0d82d5f7e',
              turn: { id: 't', status: 'failed', error: { message: 'usage limit reached' } },
            },
          }
        : n,
    );
    const { runner, workspace } = await setup(replay(completed, { notifications: failed }));
    const { report } = await runToEnd(runner, taskFor(workspace));
    expect(report).toMatchObject({
      status: 'failed',
      summary: 'Codex-turnen fejlede: usage limit reached',
    });
  });

  it('fails cleanly when the app-server crashes mid-turn', async () => {
    const { runner, workspace, fakes } = await setup(replay(interrupted, { pauseAt: () => true }));
    const events: RunEvent[] = [];
    for await (const event of runner.run(taskFor(workspace))) {
      events.push(event);
      if (event.type === 'started') {
        setTimeout(() => {
          fakes.latest().exit({ code: 1 });
        }, 10);
      }
    }
    expect(events.at(-1)).toMatchObject({
      type: 'report',
      report: { status: 'failed', summary: 'codex app-server stoppede midt i turnen.' },
    });
    expect(workspace.commitMessages).toEqual(['WIP: demo#1 (failed)']);
  });

  it('fails cleanly when thread/start is rejected', async () => {
    const { runner, workspace } = await setup((message, conn) => {
      codexResponder()(message, conn);
      if (message.method === 'thread/start') {
        queueMicrotask(() => {
          conn.emit({ id: message.id, error: { code: -32600, message: 'bad cwd' } });
        });
      }
    });
    const { report } = await runToEnd(runner, taskFor(workspace));
    expect(report).toMatchObject({
      status: 'failed',
      summary: 'thread/start failed with -32600: bad cwd',
    });
  });
});
