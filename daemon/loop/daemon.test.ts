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
import type { QuotaSnapshot, QuotaSource } from '../quota/quota.js';
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
  added: { contentId: string; status: string }[] = [];
  constructor(public items: BoardItem[]) {}
  read(): Promise<BoardSnapshot> {
    return Promise.resolve({
      projectId: 'p',
      statusFieldId: 'f',
      statusOptions: new Map(['Ready', 'In progress', 'In review', 'Done'].map((s) => [s, s])),
      items: this.items.map((i) => ({ ...i })),
    });
  }
  moveAfter(itemId: string, afterItemId: string | null): Promise<void> {
    const item = this.items.find((i) => i.itemId === itemId);
    if (!item) return Promise.resolve();
    this.items = this.items.filter((i) => i !== item);
    const at = afterItemId === null ? 0 : this.items.findIndex((i) => i.itemId === afterItemId) + 1;
    this.items.splice(at, 0, item);
    return Promise.resolve();
  }
  add(contentId: string, status: string): Promise<void> {
    this.added.push({ contentId, status });
    return Promise.resolve();
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

/** A quota source that returns whatever snapshot the test sets, and counts reads. */
class FakeQuota implements QuotaSource {
  reads = 0;
  constructor(public snapshot: QuotaSnapshot) {}
  read(): Promise<QuotaSnapshot> {
    this.reads++;
    return Promise.resolve(this.snapshot);
  }
  subscribe(): () => void {
    return () => undefined;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// The harness clock starts Sunday 11 October 2026, 20:00 in Copenhagen.
const FIVE_HOUR_RESET = '2026-10-11T19:30:00.000Z';
// Friday 16 October 00:00 in Copenhagen: five days after Sunday's midnight.
const WEEKLY_RESET = '2026-10-15T22:00:00.000Z';
const quotaSnapshot = (fiveHourUsed: number, weeklyUsed: number): QuotaSnapshot => ({
  fiveHour: { usedPercent: fiveHourUsed, resetsAt: FIVE_HOUR_RESET },
  weekly: { usedPercent: weeklyUsed, resetsAt: WEEKLY_RESET },
  fetchedAt: '2026-10-11T18:00:00.000Z',
});

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
  options: {
    items?: BoardItem[];
    runner?: (inner: ScriptRunner) => Runner;
    quota?: QuotaSource;
    /** Adds a second project, "other" (o/other). */
    other?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'ai-factory-daemon-'));
  const project: Project = { name: 'demo', repo: 'o/demo', path: dir };
  const projects = new Map([[project.name, project]]);
  if (options.other) projects.set('other', { name: 'other', repo: 'o/other', path: dir });
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
    project: (name) => Promise.resolve(projects.get(name) ?? project),
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
    projects: () => Promise.resolve(projects),
    library,
    knownRunners: ['codex'],
    ...(options.quota && { quota: options.quota }),
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
    const gated: { runner?: GatedRunner } = {};
    const h = await harness({ runner: (inner) => (gated.runner = new GatedRunner(inner)) });
    const running = h.daemon.tick();
    // Wait until the agent turn really runs, so the command interrupts it.
    await gated.runner?.started;
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
    const gated: { runner?: GatedRunner } = {};
    const h = await harness({ runner: (inner) => (gated.runner = new GatedRunner(inner)) });
    const running = h.daemon.tick();
    // Wait until the agent turn really runs, so the command interrupts it.
    await gated.runner?.started;
    h.comment('/factory halt');
    await h.daemon.pollCommands();
    await running;
    expect(existsSync(join(h.dir, 'HALT'))).toBe(true);
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('stopped');
    expect(await h.daemon.tick()).toBe('paused');
  });
});

describe('Daemon: quota policy', () => {
  it('waits for the 5-hour reset below pause_below_5h, re-reads every 5 minutes, then resumes', async () => {
    const quota = new FakeQuota(quotaSnapshot(90, 20));
    const h = await harness({ quota });
    expect(await h.daemon.tick()).toBe('waiting');
    expect(h.daemon.mode).toBe('waiting_quota');
    expect(h.daemon.state()).toMatchObject({
      mode: 'waiting_quota',
      reason: '5-timersvinduet har 10 % tilbage (grænsen er 15 %).',
      nextStart: FIVE_HOUR_RESET,
    });
    expect(h.board.moves).toEqual([]);
    expect(h.script.tasks).toEqual([]);

    await h.daemon.heartbeat();
    const body = h.github.issueBodies.get(h.github.createdIssues[0]?.number ?? 0) ?? '';
    expect(body).toContain('**Tilstand:** Venter på kvote');
    expect(body).toContain('**Næste start:** 2026-10-11 21:30:00');

    h.advance(60_000);
    expect(await h.daemon.tick()).toBe('waiting');
    expect(quota.reads).toBe(1);
    h.advance(5 * 60_000);
    expect(await h.daemon.tick()).toBe('waiting');
    expect(quota.reads).toBe(2);

    quota.snapshot = quotaSnapshot(0, 20);
    h.advance(90 * 60_000);
    await h.tickUntilIdle();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('done');
    expect(h.daemon.state().nextStart).toBeNull();
  });

  it('lets the running turn finish and starts no new one when the daily budget is spent', async () => {
    // Sunday 20:00: 60 % is left, and 4 of the 100 hours until the reset fall before midnight.
    const quota = new FakeQuota(quotaSnapshot(10, 40));
    const h = await harness({ quota });
    h.script.script({}, { output: { score: 3, passed: false, feedback: ['Mangler tests.'] } });
    expect(await h.daemon.tick()).toBe('worked');
    expect(h.script.writeTasks).toHaveLength(1);

    quota.snapshot = quotaSnapshot(30, 43);
    h.advance(1000);
    expect(await h.daemon.tick()).toBe('waiting');
    expect(h.daemon.state()).toMatchObject({
      mode: 'waiting_quota',
      reason: 'Dagens budget på 2,4 % af ugekvoten er brugt.',
      // Monday 00:00 in Copenhagen.
      nextStart: '2026-10-11T22:00:00.000Z',
      quota: { pacing: { day: '2026-10-11', budget: 2.4, usedToday: 3 } },
    });
    expect(h.script.writeTasks).toHaveLength(1);
    expect(h.store.findLatestRun('demo', 12)).toMatchObject({ status: 'active', attempt: 2 });
  });

  it('treats a Codex usage limit as waiting for quota, not as a failed attempt', async () => {
    const quota = new FakeQuota(quotaSnapshot(50, 30));
    const h = await harness({ quota });
    h.script.script({ quota: true });
    expect(await h.daemon.tick()).toBe('worked');
    expect(h.daemon.state()).toMatchObject({
      mode: 'waiting_quota',
      reason: 'Codex meldte, at kvoten er brugt op.',
      nextStart: FIVE_HOUR_RESET,
    });
    expect(h.store.findLatestRun('demo', 12)).toMatchObject({
      status: 'active',
      attempt: 1,
      ladderUsed: 0,
    });

    h.advance(10 * 60_000);
    expect(await h.daemon.tick()).toBe('waiting');
    expect(h.script.writeTasks).toHaveLength(1);

    h.advance(90 * 60_000);
    await h.tickUntilIdle();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('done');
    expect(h.store.findLatestRun('demo', 12)?.feedback).toEqual([]);
  });
});

describe('Daemon: live state for the API', () => {
  it("re-reads the quota after a step, counts today's PRs and tells listeners", async () => {
    const quota = new FakeQuota(quotaSnapshot(10, 20));
    const h = await harness({ quota });
    let changes = 0;
    const lines: string[] = [];
    h.daemon.onChange(() => changes++);
    h.daemon.onLog((line) => lines.push(line));
    quota.read = () => {
      quota.reads++;
      // The step costs 4 % of the 5-hour window.
      return Promise.resolve(quota.reads === 1 ? quotaSnapshot(10, 20) : quotaSnapshot(14, 21));
    };
    expect(await h.daemon.tick()).toBe('worked');
    expect(quota.reads).toBe(2);
    expect(h.daemon.state().quota?.snapshot.fiveHour.usedPercent).toBe(14);
    expect(h.daemon.state().today).toEqual({ prs: 1, merged: 0, firstPass: 100 });
    expect(changes).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Starter workflow'))).toBe(true);

    h.github.mergedPrs.add(5);
    await h.daemon.heartbeat();
    expect(h.daemon.state().today.merged).toBe(1);
  });
});

describe('Daemon: commands from the API', () => {
  it('switches to paused and back at once, and logs the command', async () => {
    const h = await harness({ items: [] });
    await h.daemon.tick();
    expect(await h.daemon.execute({ command: 'pause' })).toEqual({
      text: 'Fabrikken holder pause.',
      reply: false,
    });
    expect(h.daemon.state()).toMatchObject({
      mode: 'paused',
      reason: 'Sat på pause med /factory pause.',
    });
    await h.daemon.execute({ command: 'resume' });
    expect(h.daemon.state()).toMatchObject({ mode: 'idle', reason: null });
    expect(h.lines.filter((l) => l.includes('Kommando /factory'))).toHaveLength(2);
  });
});

describe('Daemon: dashboard controls', () => {
  it('moves a Ready card one place up past other columns, and says when it is on top', async () => {
    const h = await harness({
      items: [
        card(1),
        card(2, { status: 'In progress' }),
        card(3, { labels: ['factory:hold'] }),
        card(4),
      ],
    });
    // up reads the board itself; no pass is needed first.
    expect(await h.daemon.execute({ command: 'up', issue: 4, project: 'demo' })).toMatchObject({
      text: 'demo#4 er rykket én plads op.',
    });
    expect(h.board.items.map((i) => i.number)).toEqual([1, 2, 4, 3]);
    await h.daemon.execute({ command: 'up', issue: 4, project: 'demo' });
    expect(h.board.items.map((i) => i.number)).toEqual([4, 1, 2, 3]);
    expect((await h.daemon.execute({ command: 'up', issue: 4, project: 'demo' })).text).toBe(
      'demo#4 er allerede øverst.',
    );
  });

  it('holds and releases a card, and shows it in the queue', async () => {
    const h = await harness({ items: [card(12, { labels: ['factory:hold'] })] });
    await h.github.addLabels('o/demo', 12, ['factory:hold']);
    await h.daemon.tick();
    expect(h.daemon.state().queue[0]).toMatchObject({ issue: 12, held: true });
    await h.daemon.execute({ command: 'release', issue: 12, project: 'demo' });
    expect(h.github.labelsOf(12)).toEqual([]);
    expect(h.daemon.state().queue[0]?.held).toBe(false);
  });

  it('lifts its own emergency brake on resume', async () => {
    const h = await harness({ items: [] });
    await h.daemon.execute({ command: 'halt' });
    expect(h.daemon.state().halted).toBe(true);
    expect(await h.daemon.tick()).toBe('paused');
    await h.daemon.execute({ command: 'resume' });
    expect(existsSync(join(h.dir, 'HALT'))).toBe(false);
    expect(h.daemon.state().halted).toBe(false);
    expect(await h.daemon.tick()).toBe('idle');
  });

  it('shows the workflow steps, the runner and the projects while working', async () => {
    const h = await harness({ runner: (inner) => new GatedRunner(inner) });
    const running = h.daemon.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const state = h.daemon.state();
    expect(state.current).toMatchObject({
      runner: 'codex',
      steps: [
        { label: 'implement', state: 'active' },
        { label: 'CI', state: 'pending' },
        { label: 'Review', state: 'pending' },
      ],
    });
    expect(state.projects).toEqual([{ name: 'demo', repo: 'o/demo', enabled: true }]);
    expect(state.runners).toEqual(['codex']);
    await h.daemon.execute({ command: 'stop', issue: 12, project: 'demo' });
    await running;
  });
});

describe('Daemon: several projects', () => {
  it('takes cards across projects in board order and passes over a disabled project', async () => {
    const h = await harness({
      other: true,
      items: [card(12), card(7, { repo: 'o/other', url: 'https://github.com/o/other/issues/7' })],
    });
    h.github.setIssue({ ...h.github.issue, number: 7 });
    await h.daemon.execute({ command: 'disable', project: 'demo' });
    expect(h.daemon.state().projects).toEqual([
      { name: 'demo', repo: 'o/demo', enabled: false },
      { name: 'other', repo: 'o/other', enabled: true },
    ]);
    await h.daemon.tick();
    expect(h.board.moves[0]).toEqual({ itemId: 'item-7', status: 'In progress' });
    expect(h.daemon.state().queue.map((q) => [q.project, q.issue, q.skip])).toEqual([
      ['demo', 12, 'demo er slukket'],
      ['other', 7, undefined],
    ]);
    expect(h.daemon.statusText()).toContain('**Slukket:** demo');
  });

  it('leaves the active run of a disabled project and goes on with the others', async () => {
    const h = await harness({
      other: true,
      items: [card(12), card(7, { repo: 'o/other' })],
    });
    h.github.setIssue({ ...h.github.issue, number: 7 });
    // A failed review keeps demo#12 active after its first step.
    h.script.script({}, { output: { score: 3, passed: false, feedback: ['Mangler tests.'] } });
    await h.daemon.tick();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('active');
    h.comment('/factory disable');
    h.advance(1000); // run ids come from the clock
    await h.daemon.tick();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('active');
    expect(h.store.findLatestRun('other', 7)).toBeDefined();
    expect(h.lines.some((l) => l.includes('Kommando /factory disable: demo er slukket'))).toBe(
      true,
    );

    await h.daemon.execute({ command: 'enable', project: 'demo' });
    expect(h.daemon.state().projects.every((p) => p.enabled)).toBe(true);
    await h.tickUntilIdle();
    expect(h.store.findLatestRun('demo', 12)?.status).toBe('done');
  });

  it('refuses to switch an unknown project', async () => {
    const h = await harness({ items: [] });
    const result = await h.daemon.execute({ command: 'disable', project: 'nope' });
    expect(result).toMatchObject({ reply: true });
    expect(result.text).toContain('ukendt projekt "nope"');
  });
});

describe('Daemon: the idea workflow', () => {
  it('shows what an idea waits for, and leaves the planned epic in progress', async () => {
    const h = await harness();
    h.github.issue = { ...h.github.issue, labels: [{ name: 'idea' }] };
    h.script.script(
      { output: { status: 'done', summary: 'Brief.', comment: '## Decision Brief' } },
      {},
      {
        output: {
          status: 'done',
          summary: 'Plan.',
          issues: [{ key: 'a', title: 'A', body: 'B', area: 'gallery', dependsOn: [] }],
        },
      },
    );
    await h.tickUntilIdle();
    expect(h.daemon.state().waitingForYou).toEqual([
      expect.objectContaining({ issue: 12, kind: 'needs-you', text: 'venter på dit svar' }),
    ]);
    await h.daemon.execute({ command: 'approve', issue: 12, project: 'demo' });
    await h.tickUntilIdle();
    expect(h.daemon.state().waitingForYou[0]?.text).toBe('venter på, at du merger PR’en');
    h.github.mergedPrs.add(5);
    await h.tickUntilIdle();
    expect(h.store.findLatestRun('demo', 12)).toMatchObject({ status: 'done', outcome: 'planned' });
    expect(h.board.moves).toEqual([{ itemId: 'item-12', status: 'In progress' }]);
    expect(h.daemon.state().waitingForYou).toEqual([]);
  });
});

describe('Daemon: /factory boost', () => {
  it('sets the quota rules aside until midnight, then they apply again', async () => {
    const quota = new FakeQuota(quotaSnapshot(90, 40));
    const h = await harness({ quota });
    h.script.script({}, { output: { score: 3, passed: false, feedback: ['Mangler tests.'] } });
    expect(await h.daemon.tick()).toBe('waiting');

    h.comment('/factory boost');
    h.advance(60_000);
    expect(await h.daemon.tick()).toBe('worked');
    expect(h.script.writeTasks).toHaveLength(1);
    const reply = h.github.comments.at(-1)?.body ?? '';
    expect(reply).toContain('Kvotereglerne er tilsidesat til i morgen kl. 00.00');
    expect(h.daemon.state().quotaOverrideUntil).toBe('2026-10-11T22:00:00.000Z');

    h.advance(4 * 60 * 60_000);
    expect(await h.daemon.tick()).toBe('waiting');
    expect(h.daemon.state().quotaOverrideUntil).toBeNull();
    expect(h.lines.some((l) => l.includes('Boost er udløbet'))).toBe(true);
  });

  it('still stops when Codex itself has no quota left, and boost off ends it early', async () => {
    const quota = new FakeQuota(quotaSnapshot(100, 40));
    const h = await harness({ quota });
    h.comment('/factory boost 2h');
    expect(await h.daemon.tick()).toBe('waiting');
    expect(h.daemon.state()).toMatchObject({
      reason: '5-timersvinduet er brugt op hos Codex.',
      nextStart: FIVE_HOUR_RESET,
      quotaOverrideUntil: '2026-10-11T20:00:00.000Z',
    });

    h.comment('/factory boost off');
    h.advance(60_000);
    await h.daemon.tick();
    expect(h.daemon.state().quotaOverrideUntil).toBeNull();
    expect(h.daemon.state().reason).toBe('5-timersvinduet har 0 % tilbage (grænsen er 15 %).');
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
