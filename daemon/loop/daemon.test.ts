import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRun, FakeGitHub } from '../../test/support/fakeGitHub.js';
import { FakeWorkspace } from '../../test/support/fakeWorkspace.js';
import { ScriptRunner } from '../../test/support/scriptRunner.js';
import { FactoryConfig } from '../config/factoryConfig.js';
import { factoryRoot, type Project } from '../config/projects.js';
import type { Board, BoardItem, BoardSnapshot } from '../github/board.js';
import { FACTORY_COMMENT_MARKER, type IssueComment } from '../github/github.js';
import type { RunEvent, Runner, RunTask } from '../runner/runner.js';
import { SqliteStore } from '../store/store.js';
import { LABELS, WorkflowEngine } from '../workflow/engine.js';
import { AgentLibrary } from '../workflow/load.js';
import { Daemon } from './daemon.js';
import { parseStatusIssue } from './statusIssue.js';

const config = FactoryConfig.parse({
  board: {
    owner: 'nikolajjepsen',
    number: 1,
    status: { ready: 'Ready', in_progress: 'In progress', review: 'In review', done: 'Done' },
  },
  owner_login: 'nikolajjepsen',
  status_repo: 'nikolajjepsen/factory',
});

class FakeBoard implements Board {
  moves: { itemId: string; status: string }[] = [];
  constructor(public items: BoardItem[]) {}
  read(): Promise<BoardSnapshot> {
    return Promise.resolve({
      projectId: 'p',
      statusFieldId: 'f',
      statusOptions: new Map(['Ready', 'In progress', 'In review', 'Done'].map((s) => [s, s])),
      items: this.items.map((i) => ({ ...i })),
    });
  }
  setStatus(itemId: string, status: string): Promise<void> {
    this.moves.push({ itemId, status });
    const item = this.items.find((i) => i.itemId === itemId);
    if (item) item.status = status;
    return Promise.resolve();
  }
}

/** A runner whose turns wait until released, to send commands while a step runs. */
class GatedRunner implements Runner {
  readonly name = 'codex';
  release: () => void = () => undefined;
  started: Promise<void>;
  #markStarted: () => void = () => undefined;
  constructor(private readonly inner: ScriptRunner) {
    this.started = new Promise((resolve) => (this.#markStarted = resolve));
  }
  async *run(task: RunTask): AsyncIterable<RunEvent> {
    const released = new Promise<void>((resolve) => {
      this.release = resolve;
      task.signal?.addEventListener('abort', () => {
        resolve();
      });
    });
    this.#markStarted();
    await released;
    yield* this.inner.run(task);
  }
}

const card = (number: number, overrides: Partial<BoardItem> = {}): BoardItem => ({
  itemId: `item-${String(number)}`,
  status: 'Ready',
  repo: 'o/demo',
  number,
  title: 'Tilføj add()',
  url: `https://github.com/o/demo/issues/${String(number)}`,
  open: true,
  labels: [],
  openSubIssues: [],
  openBlockers: [],
  ...overrides,
});

async function harness(
  options: { items?: BoardItem[]; runner?: (inner: ScriptRunner) => Runner } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-factory-daemon-'));
  const project: Project = { name: 'demo', repo: 'o/demo', path: dir };
  const github = new FakeGitHub();
  github.checkRunSequence = [[checkRun()]];
  const board = new FakeBoard(options.items ?? [card(12)]);
  let clock = new Date('2026-10-11T18:00:00.000Z').getTime();
  const now = () => new Date(clock);
  const store = new SqliteStore(':memory:', now);
  const script = new ScriptRunner();
  const runner = options.runner ? options.runner(script) : script;
  const workspace = new FakeWorkspace(dir, 'factory/12-tilfoej-add');
  const library = (p: Project) =>
    new AgentLibrary(join(factoryRoot, 'agents', 'baseline'), join(p.path, '.factory'));
  const sink: { daemon?: Daemon } = {};
  const engine = new WorkflowEngine({
    github,
    store,
    runners: new Map([['codex', runner]]),
    defaultRunner: 'codex',
    worktrees: { prepare: () => Promise.resolve(workspace) },
    project: () => Promise.resolve(project),
    library,
    ownerLogin: 'nikolajjepsen',
    ci: {
      pollMs: 1,
      timeoutMs: 60_000,
      noChecksGraceMs: 60_000,
      now,
      sleep: () => Promise.resolve(),
    },
    now,
    newId: () => `run-${String(clock)}`,
    onEvent: (event) => sink.daemon?.handleEngineEvent(event),
  });
  const lines: string[] = [];
  const daemon = new Daemon({
    config,
    github,
    board,
    store,
    engine,
    projects: () => Promise.resolve(new Map([[project.name, project]])),
    library,
    knownRunners: ['codex'],
    haltFile: join(dir, 'HALT'),
    now,
    // Yield to the event loop, so run() loops do not starve timers in tests.
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    log: (line) => lines.push(line),
    timeZone: 'Europe/Copenhagen',
    watchMs: 5,
  });
  sink.daemon = daemon;
  let commentId = 0;
  const comment = (body: string, overrides: Partial<IssueComment> = {}) => {
    const list = github.repoComments.get(overrides.url ?? 'o/demo') ?? [];
    list.push({
      id: ++commentId,
      issueNumber: 12,
      author: 'nikolajjepsen',
      body,
      createdAt: now().toISOString(),
      url: 'u',
      ...overrides,
    });
    github.repoComments.set('o/demo', list);
    return commentId;
  };
  const tickUntilIdle = async (max = 20) => {
    for (let i = 0; i < max; i++) {
      clock += 1000;
      if ((await daemon.tick()) !== 'worked') return;
    }
  };
  return {
    daemon,
    github,
    board,
    store,
    script,
    workspace,
    project,
    dir,
    comment,
    tickUntilIdle,
    lines,
    advance: (ms: number) => (clock += ms),
  };
}

describe('Daemon: the assembly line', () => {
  it('takes a toy issue from Ready to a green, reviewed PR without human help', async () => {
    const h = await harness();
    await h.tickUntilIdle();
    expect(h.board.moves).toEqual([
      { itemId: 'item-12', status: 'In progress' },
      { itemId: 'item-12', status: 'In review' },
    ]);
    expect(h.github.labelsOf(5)).toEqual([LABELS.readyToMerge]);
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('done');
    expect(h.daemon.mode).toBe('idle');
    expect(h.daemon.state().waitingForYou).toEqual([
      {
        project: 'demo',
        issue: 12,
        kind: 'ready-to-merge',
        text: 'grøn og reviewet',
        url: 'https://github.com/o/demo/pull/5',
      },
    ]);
  });

  it('works the Ready column in board order and leaves cards it must skip', async () => {
    const h = await harness({
      items: [
        card(3, { labels: ['factory:hold'] }),
        card(4, { openBlockers: ['o/demo#1'] }),
        card(12),
      ],
    });
    await h.daemon.tick();
    expect(h.board.moves[0]).toEqual({ itemId: 'item-12', status: 'In progress' });
    expect(h.daemon.state().queue.map((q) => [q.issue, q.skip])).toEqual([
      [3, 'factory:hold'],
      [4, 'blokeret af o/demo#1'],
      [12, undefined],
    ]);
  });

  it('is idle when nothing is ready', async () => {
    const h = await harness({ items: [card(12, { status: 'Backlog' })] });
    expect(await h.daemon.tick()).toBe('idle');
    expect(h.daemon.mode).toBe('idle');
  });
});

describe('Daemon: ChatOps', () => {
  it('pauses on /factory pause from the owner before the next step, and resumes', async () => {
    const h = await harness();
    await h.daemon.tick(); // first step of #12
    h.comment('/factory pause');
    expect(await h.daemon.tick()).toBe('paused');
    expect(h.daemon.mode).toBe('paused');
    expect(h.github.reactions).toHaveLength(1);
    h.comment('/factory resume');
    await h.tickUntilIdle();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('done');
  });

  it('ignores comments from others, factory comments and comments it already handled', async () => {
    const h = await harness();
    h.comment('/factory pause', { author: 'mallory' });
    h.comment(`**Venter på dig.**\n/factory pause\n\n${FACTORY_COMMENT_MARKER}`);
    await h.daemon.tick();
    expect(h.daemon.mode).not.toBe('paused');
    h.comment('/factory pause');
    await h.daemon.tick();
    expect(h.daemon.mode).toBe('paused');
    h.advance(30_000);
    await h.daemon.pollCommands();
    expect(h.github.reactions).toHaveLength(1);
  });

  it('feeds /factory reject into the next step as a failed gate', async () => {
    const h = await harness();
    await h.daemon.tick(); // implement + gates: done in one step
    // Start a fresh run on another card so there is something to reject.
    h.board.items.push(card(13));
    h.github.setIssue({ ...h.github.issue, number: 13 });
    await h.daemon.tick();
    h.comment('/factory reject #13 "Brug Math.min"', { issueNumber: 13 });
    await h.daemon.pollCommands();
    expect(h.store.takeDecision('demo', 13, 'reject')?.feedback).toBe('Brug Math.min');
  });

  it('answers /factory status with a reply comment and reports bad commands', async () => {
    const h = await harness();
    h.comment('/factory status\n/factory dance');
    await h.daemon.pollCommands();
    const reply = h.github.comments.at(-1)?.body ?? '';
    expect(reply).toContain('Kunne ikke forstå "/factory dance"');
    expect(reply).toContain('**Tilstand:**');
  });

  it('stops a running step on /factory stop and keeps the WIP', async () => {
    const h = await harness({ runner: (inner) => new GatedRunner(inner) });
    const running = h.daemon.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.comment('/factory stop #12');
    await h.daemon.pollCommands();
    await running;
    const run = h.store.findLatestRun('demo', 12);
    expect(run?.status).toBe('stopped');
    expect(h.workspace.commitMessages).toEqual(['WIP: demo#12 (interrupted)']);
  });

  it('retries a blocked run from the bottom of its ladder, optionally on another runner', async () => {
    const h = await harness();
    h.script.script(...Array.from({ length: 4 }, () => ({ error: 'nej' })));
    await h.tickUntilIdle();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('blocked');
    expect(h.github.labelsOf(12)).toContain(LABELS.blocked);

    h.comment('/factory retry #12 --runner claude');
    await h.daemon.pollCommands();
    expect(h.github.comments.at(-1)?.body).toContain('Runneren "claude" findes ikke');

    h.comment('/factory retry #12');
    await h.tickUntilIdle();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('done');
    expect(h.github.labelsOf(12)).not.toContain(LABELS.blocked);
  });

  it('holds an issue and switches its workflow for the next start', async () => {
    const h = await harness({ items: [card(12, { status: 'Backlog' })] });
    h.comment('/factory hold #12\n/factory workflow #12 chore\n/factory focus demo');
    await h.daemon.pollCommands();
    expect(h.github.labelsOf(12)).toEqual(['factory:hold']);
    expect(h.store.getWorkflowOverride('demo', 12)).toBe('chore');
    expect(h.daemon.state().focus).toBe('demo');
    h.comment('/factory workflow #12 nope');
    await h.daemon.pollCommands();
    expect(h.github.comments.at(-1)?.body).toContain('Workflowet "nope" findes ikke');
  });
});

describe('Daemon: emergency brake', () => {
  it('pauses while ~/.ai-factory/HALT exists', async () => {
    const h = await harness();
    await writeFile(join(h.dir, 'HALT'), '');
    expect(await h.daemon.tick()).toBe('paused');
    expect(h.daemon.state().reason).toMatch(/HALT findes/);
    expect(h.board.moves).toEqual([]);
  });

  it('pauses while an open issue in a project repo has factory:halt', async () => {
    const h = await harness();
    h.github.openLabels.add('o/demo:factory:halt');
    expect(await h.daemon.tick()).toBe('paused');
    expect(h.daemon.state().reason).toMatch(/factory:halt/);
  });

  it('/factory halt writes the HALT file and interrupts the running step', async () => {
    const h = await harness({ runner: (inner) => new GatedRunner(inner) });
    const running = h.daemon.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    h.comment('/factory halt');
    await h.daemon.pollCommands();
    await running;
    expect(existsSync(join(h.dir, 'HALT'))).toBe(true);
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('stopped');
    expect(await h.daemon.tick()).toBe('paused');
  });
});

describe('Daemon: heartbeat', () => {
  it('publishes the state to the pinned Factory Status issue', async () => {
    const h = await harness();
    await h.daemon.tick();
    await h.daemon.heartbeat();
    const [created] = h.github.createdIssues;
    expect(created?.repo).toBe('nikolajjepsen/factory');
    expect(h.github.pinned).toEqual([created?.number]);
    const state = parseStatusIssue(h.github.issueBodies.get(created?.number ?? 0) ?? '');
    expect(state?.mode).toBe('running');
    expect(state?.log.some((l) => l.includes('Starter workflow "feature"'))).toBe(true);
  });

  it('records errors as mode error and keeps going', async () => {
    const h = await harness();
    h.board.read = () => Promise.reject(new Error('GitHub svarer ikke'));
    const controller = new AbortController();
    const loop = h.daemon.run(controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await loop;
    expect(h.lines.some((l) => l.includes('Tilstand: error (GitHub svarer ikke)'))).toBe(true);
  });
});
