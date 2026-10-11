import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import type { FactoryConfig } from '../config/factoryConfig.js';
import type { Project } from '../config/projects.js';
import type { CommandResult, QuotaSnapshot, TodayStats } from '@ai-factory/protocol';
import { type Command, parseChatOps } from '../control/commands.js';
import type { Board, BoardItem } from '../github/board.js';
import { FACTORY_COMMENT_MARKER, type GitHub } from '../github/github.js';
import { formatResetTime } from '../quota/formatQuota.js';
import {
  evaluateQuota,
  latest,
  nextLocalMidnight,
  PacingDay,
  type QuotaBlock,
  type QuotaStatus,
  usageLimitResetTime,
} from '../quota/policy.js';
import type { QuotaSource } from '../quota/quota.js';
import { QuotaExhaustedError } from '../runner/runner.js';
import type { Store } from '../store/store.js';
import { type EngineEvent, LABELS, type WorkflowEngine } from '../workflow/engine.js';
import type { AgentLibrary } from '../workflow/load.js';
import type { RunState } from '../workflow/runState.js';
import type { Workflow } from '../workflow/schema.js';
import { stepsFor } from '../workflow/steps.js';
import { HOLD_LABEL, pickNext } from './picker.js';
import { prKey, prsOpenedToday, todayStats } from './today.js';
import type { CurrentWork, DaemonMode, FactoryState, QueueEntry, WaitingEntry } from './state.js';
import { StatusIssue } from './statusIssue.js';

export const HALT_LABEL = 'factory:halt';

export interface DaemonDeps {
  config: FactoryConfig;
  github: GitHub;
  board: Board;
  store: Store;
  engine: WorkflowEngine;
  projects: () => Promise<Map<string, Project>>;
  library: (project: Project) => AgentLibrary;
  knownRunners: readonly string[];
  /** Where the quota is read. Without it, the quota policy is off. */
  quota?: QuotaSource;
  /** `~/.ai-factory/HALT`: while it exists, nothing runs. */
  haltFile: string;
  now: () => Date;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
  timeZone?: string;
  /** Pause between ticks when there is nothing to do. */
  idleMs?: number;
  heartbeatMs?: number;
  /** How often halt and commands are checked while an agent step runs. */
  watchMs?: number;
}

export type { CommandResult } from '@ai-factory/protocol';

const SETTING = {
  paused: 'paused',
  focus: 'focus',
  commentsSince: 'comments_since',
  pacingDay: 'quota_pacing_day',
  boostUntil: 'quota_boost_until',
} as const;
const LOG_LINES = 50;
const PAUSED_REASON = 'Sat på pause med /factory pause.';
/** How far back the first comment poll looks, so old commands are not replayed. */
const FIRST_POLL_LOOKBACK_MS = 10 * 60_000;
/** Overlap between polls; handled comment ids make it safe. */
const POLL_OVERLAP_MS = 2 * 60_000;
const DONE_VISIBLE_MS = 7 * 24 * 60 * 60_000;
/** How often the quota is read while waiting for it, and while idle. */
const QUOTA_POLL_MS = 5 * 60_000;

/**
 * The factory's main loop. Each tick: read commands, respect halt and pause, check runs parked on
 * a human gate, advance one active run by one step, or take the top workable card from "ready".
 * Commands are applied between steps; halt and `stop` also interrupt a running step.
 */
export class Daemon {
  readonly #deps: DaemonDeps;
  readonly #statusIssue: StatusIssue;
  #mode: DaemonMode = 'idle';
  #reason: string | undefined;
  #current: FactoryState['current'] = null;
  #currentAbort: AbortController | undefined;
  #queue: QueueEntry[] = [];
  #boardItems: BoardItem[] = [];
  /** Project name → repo, refreshed whenever projects.yml is read. */
  #repos = new Map<string, string>();
  readonly #log: string[] = [];
  #polling = false;
  #halted = false;
  /** The workflow of the run in `#current`, for its progress steps. */
  #currentWorkflow: Workflow | undefined;
  /** Aborted by a command, so a sleeping loop reacts at once. */
  #wake = new AbortController();
  #heartbeatAt: string | undefined;
  #today: TodayStats = { prs: 0, merged: 0, firstPass: null };
  /** `project#pr` of today's PRs found merged, so each is looked up until it merges. */
  readonly #merged = new Set<string>();
  readonly #changeListeners = new Set<() => void>();
  readonly #logListeners = new Set<(line: string) => void>();
  #quota: QuotaStatus | undefined;
  #quotaReadAt = 0;
  /** Set when Codex reported a usage limit the snapshot did not show: no new turns before `until`. */
  #usageLimit: (QuotaBlock & { until: number }) | undefined;
  #nextStart: string | null = null;

  constructor(deps: DaemonDeps) {
    this.#deps = deps;
    this.#statusIssue = new StatusIssue(deps.github, deps.config.status_repo, deps.timeZone);
  }

  get mode(): DaemonMode {
    return this.#mode;
  }

  get #paused(): boolean {
    return this.#deps.store.getSetting(SETTING.paused) === 'true';
  }

  /** Until when `/factory boost` sets the quota rules aside, or null. Clears an expired boost. */
  #boostUntil(): string | null {
    const until = this.#deps.store.getSetting(SETTING.boostUntil);
    if (!until) return null;
    if (this.#deps.now().getTime() < Date.parse(until)) return until;
    this.#deps.store.setSetting(SETTING.boostUntil, undefined);
    this.#write('Boost er udløbet. Kvotereglerne gælder igen.');
    return null;
  }

  get #focus(): string | null {
    return this.#deps.store.getSetting(SETTING.focus) ?? null;
  }

  state(): FactoryState {
    const { store, now } = this.#deps;
    const waiting: WaitingEntry[] = [];
    const recent = now().getTime() - DONE_VISIBLE_MS;
    for (const run of store.listRuns(['waiting', 'blocked', 'done'])) {
      const url = run.pr?.url ?? this.#itemFor(run)?.url;
      const base = { project: run.project, issue: run.issue, ...(url && { url }) };
      if (run.status === 'waiting')
        waiting.push({ ...base, kind: 'needs-you', text: 'venter på din godkendelse' });
      else if (run.status === 'blocked')
        waiting.push({ ...base, kind: 'blocked', text: run.reason ?? 'blokeret' });
      else if (new Date(run.updatedAt).getTime() >= recent) {
        waiting.push({ ...base, kind: 'ready-to-merge', text: 'grøn og reviewet' });
      }
    }
    return {
      mode: this.#mode,
      reason: this.#reason ?? null,
      heartbeat: this.#heartbeatAt ?? now().toISOString(),
      nextStart: this.#mode === 'waiting_quota' ? this.#nextStart : null,
      quota: this.#quota
        ? {
            snapshot: this.#quota.snapshot,
            ...(this.#quota.pacing && { pacing: this.#quota.pacing }),
          }
        : null,
      quotaOverrideUntil: this.#boostUntil(),
      today: this.#today,
      focus: this.#focus,
      projects: [...this.#repos].map(([name, repo]) => ({ name, repo })),
      runners: [...this.#deps.knownRunners],
      halted: this.#halted,
      current: this.#current,
      queue: this.#queue,
      waitingForYou: waiting,
      log: [...this.#log],
    };
  }

  /** Called after anything in the state may have changed. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Called with every new log line. Returns an unsubscribe function. */
  onLog(listener: (line: string) => void): () => void {
    this.#logListeners.add(listener);
    return () => this.#logListeners.delete(listener);
  }

  /** Feeds engine events into the log and the "working on" status. */
  handleEngineEvent(event: EngineEvent): void {
    this.#changed();
    const target = `${event.run.project}#${String(event.run.issue)}`;
    if (
      this.#current &&
      this.#current.project === event.run.project &&
      this.#current.issue === event.run.issue
    ) {
      Object.assign(this.#current, {
        workflow: event.run.workflow,
        stage: event.run.stageId,
        phase: event.run.phase,
        attempt: event.run.attempt,
        ...this.#progress(event.run),
      });
    }
    switch (event.type) {
      case 'status':
        this.#write(`${target}: ${event.message}`);
        break;
      case 'gate':
        if (event.result.kind !== 'pending') {
          const score = event.result.score === undefined ? '' : ` ${String(event.result.score)}/10`;
          this.#write(
            `${target}: gate ${event.gate} ${event.result.kind === 'pass' ? 'bestået' : 'fejlet'}${score}`,
          );
        }
        break;
      case 'ladder':
        this.#write(`${target}: stige → ${event.step}`);
        break;
      case 'agent':
        break;
    }
  }

  /** One pass of the loop. */
  async tick(): Promise<'worked' | 'idle' | 'paused' | 'waiting'> {
    const { store, engine, board, config } = this.#deps;
    await this.pollCommands();
    const halt = await this.#haltReason();
    if (halt) return this.#pause(halt);
    if (this.#paused) return this.#pause(PAUSED_REASON);

    for (const run of store.listRuns(['waiting'])) {
      await engine.advance(run);
    }
    const active = store.listRuns(['active'])[0];
    if (active) {
      if (await this.#waitForQuota()) return 'waiting';
      await this.#step(active);
      return 'worked';
    }

    const projects = await this.#projects();
    const snapshot = await board.read();
    this.#boardItems = snapshot.items;
    const { queue, next } = pickNext(snapshot.items, {
      readyStatus: config.board.status.ready,
      projectsByRepo: new Map([...projects.values()].map((p) => [p.repo, p])),
      focus: this.#focus,
      hasRun: (project, issue) => {
        const run = store.findLatestRun(project, issue);
        return run !== undefined && run.status !== 'stopped';
      },
    });
    this.#queue = queue;
    if (!next) {
      this.#setMode('idle');
      return 'idle';
    }
    if (await this.#waitForQuota()) return 'waiting';
    await this.#moveCard(next.project, next.issue, config.board.status.in_progress);
    const run = await engine.start(next.project, next.issue);
    await this.#step(run);
    return 'worked';
  }

  /** Runs until the signal aborts. Heartbeat and the halt watch run on their own timers. */
  async run(signal: AbortSignal): Promise<void> {
    const { idleMs = 60_000, heartbeatMs = 60_000, watchMs = 30_000 } = this.#deps;
    this.#write('Daemonen starter.');
    // Codex pushes quota updates during turns; they keep the shown numbers fresh.
    const unsubscribeQuota = this.#deps.quota?.subscribe((snapshot) => {
      this.#applyQuota(snapshot);
    });
    await this.heartbeat();
    const heartbeat = setInterval(() => void this.heartbeat(), heartbeatMs);
    const watch = setInterval(() => void this.#watch(), watchMs);
    const onAbort = () => this.#currentAbort?.abort();
    signal.addEventListener('abort', onAbort);
    try {
      while (!signal.aborted) {
        let result: Awaited<ReturnType<Daemon['tick']>>;
        try {
          result = await this.tick();
        } catch (error) {
          this.#setMode('error', error instanceof Error ? error.message : String(error));
          this.#write(`Fejl: ${this.#reason ?? ''}`);
          result = 'idle';
        }
        // The signal may have fired during tick(); TypeScript's narrowing cannot see that.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (result !== 'worked' && !signal.aborted) {
          this.#wake = new AbortController();
          await this.#deps
            .sleep(idleMs, AbortSignal.any([signal, this.#wake.signal]))
            .catch(() => undefined);
        }
      }
    } finally {
      unsubscribeQuota?.();
      clearInterval(heartbeat);
      clearInterval(watch);
      signal.removeEventListener('abort', onAbort);
      this.#write('Daemonen stopper.');
      await this.heartbeat();
    }
  }

  async heartbeat(): Promise<void> {
    this.#heartbeatAt = this.#deps.now().toISOString();
    // Keep the quota shown in the status fresh while nothing else reads it.
    if (this.#deps.quota && this.#deps.now().getTime() - this.#quotaReadAt >= QUOTA_POLL_MS) {
      await this.#readQuota();
    }
    await this.#refreshToday(true);
    this.#changed();
    try {
      await this.#statusIssue.publish(this.state());
    } catch (error) {
      this.#write(`Heartbeat fejlede: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Reads `/factory` comments from the owner in the status repo and every project repo. */
  async pollCommands(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    const { store, github, config, now } = this.#deps;
    try {
      const startedAt = now();
      const last = store.getSetting(SETTING.commentsSince);
      const since = new Date(
        last
          ? new Date(last).getTime() - POLL_OVERLAP_MS
          : startedAt.getTime() - FIRST_POLL_LOOKBACK_MS,
      ).toISOString();
      const projects = await this.#projects();
      const byRepo = new Map([...projects.values()].map((p) => [p.repo, p]));
      const repos = [...new Set([config.status_repo, ...byRepo.keys()])];
      for (const repo of repos) {
        for (const comment of await github.listCommentsSince(repo, since)) {
          if (comment.author !== config.owner_login) continue;
          if (comment.body.includes(FACTORY_COMMENT_MARKER)) continue;
          if (!/^\s*\/factory\b/m.test(comment.body)) continue;
          if (!store.markCommentHandled(repo, comment.id)) continue;
          const project = byRepo.get(repo)?.name;
          const isStatusIssue =
            repo === config.status_repo && comment.issueNumber === this.#statusIssue.number;
          const { commands, errors } = parseChatOps(
            comment.body,
            isStatusIssue || !project ? {} : { issue: comment.issueNumber, project },
          );
          const replies = errors.map((e) => `Kunne ikke forstå ${e}`);
          for (const command of commands) {
            const result = await this.execute(command);
            if (result.reply) replies.push(result.text);
          }
          await github.reactToComment(repo, comment.id);
          if (replies.length > 0)
            await github.createComment(repo, comment.issueNumber, replies.join('\n\n'));
        }
      }
      store.setSetting(SETTING.commentsSince, startedAt.toISOString());
    } catch (error) {
      this.#write(
        `Læsning af kommandoer fejlede: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#polling = false;
    }
  }

  /** The single control system: ChatOps comments and the daemon API (`POST /commands`). */
  async execute(command: Command): Promise<CommandResult> {
    const result = await this.#execute(command);
    this.#write(`Kommando /factory ${command.command}: ${result.text}`);
    this.#wake.abort();
    return result;
  }

  async #execute(command: Command): Promise<CommandResult> {
    const { store, github, engine } = this.#deps;
    const done = (text: string, reply = false): CommandResult => ({ text, reply });
    try {
      switch (command.command) {
        case 'pause':
          store.setSetting(SETTING.paused, 'true');
          if (this.#currentAbort) return done('Holder pause efter det aktuelle trin.');
          this.#pause(PAUSED_REASON);
          return done('Fabrikken holder pause.');
        case 'resume': {
          store.setSetting(SETTING.paused, undefined);
          // The owner resuming lifts the brake they set with /factory halt or the dashboard.
          await rm(this.#deps.haltFile, { force: true });
          const halt = await this.#haltReason();
          if (halt) return done(`Genoptaget, men nødbremsen er stadig aktiv: ${halt}`, true);
          // The next pass decides between running, idle and waiting for quota.
          if (this.#mode === 'paused') this.#setMode('idle');
          return done('Fabrikken kører igen.');
        }
        case 'halt':
          await writeFile(this.#deps.haltFile, `Nødbremse sat ${this.#deps.now().toISOString()}\n`);
          this.#halted = true;
          this.#currentAbort?.abort();
          this.#pause(`Nødbremse: ${this.#deps.haltFile} findes.`);
          return done('Nødbremse aktiveret. Skriv /factory resume for at fortsætte.', true);
        case 'status':
          return done(this.statusText(), true);
        case 'boost': {
          // Re-evaluate the quota on the next tick, also while waiting for it.
          this.#quotaReadAt = 0;
          if (command.minutes === 0) {
            store.setSetting(SETTING.boostUntil, undefined);
            return done('Boost er slået fra. Kvotereglerne gælder igen.');
          }
          const now = this.#deps.now();
          const until =
            command.minutes === undefined
              ? nextLocalMidnight(now, this.#deps.timeZone)
              : new Date(now.getTime() + command.minutes * 60_000);
          store.setSetting(SETTING.boostUntil, until.toISOString());
          const when = formatResetTime(until.toISOString(), {
            now,
            ...(this.#deps.timeZone && { timeZone: this.#deps.timeZone }),
          });
          return done(
            `Kvotereglerne er tilsidesat til ${when}. Fabrikken stopper kun, hvis Codex' egen kvote slipper op. Forbruget trækkes fra resten af ugens budget.`,
            true,
          );
        }
        case 'focus': {
          if (!command.project) {
            store.setSetting(SETTING.focus, undefined);
            return done('Fokus fjernet. Fabrikken tager arbejde fra alle projekter.');
          }
          const project = await this.#resolveProject(command.project);
          store.setSetting(SETTING.focus, project.name);
          return done(`Fokus på ${project.name}.`);
        }
        default:
          break;
      }

      const project = await this.#resolveProject(command.project);
      const issue = command.issue;
      if (issue === undefined) return done('Kommandoen mangler et issue.', true);
      const ref = `${project.name}#${String(issue)}`;
      const isCurrent = this.#current?.project === project.name && this.#current.issue === issue;

      switch (command.command) {
        case 'stop': {
          if (isCurrent) {
            this.#currentAbort?.abort();
            return done(`Stopper ${ref}. Arbejdet gemmes som WIP-commit.`);
          }
          const open = store.findOpenRun(project.name, issue);
          if (!open) return done(`${ref} har ingen igangværende kørsel.`, true);
          this.#saveStatus(open, 'stopped', 'Stoppet med /factory stop.');
          return done(`${ref} er stoppet.`);
        }
        case 'hold': {
          await github.addLabels(project.repo, issue, [HOLD_LABEL]);
          this.#markHeld(project.repo, issue, true);
          if (isCurrent) this.#currentAbort?.abort();
          const open = store.findOpenRun(project.name, issue);
          if (open && !isCurrent) this.#saveStatus(open, 'stopped', 'Sat på hold.');
          return done(`${ref} er sat på hold. Frigiv det med /factory release #${String(issue)}.`);
        }
        case 'release':
          await github.removeLabel(project.repo, issue, HOLD_LABEL);
          this.#markHeld(project.repo, issue, false);
          return done(`${ref} er frigivet og kan tages fra Ready igen.`);
        case 'up':
          return done(await this.#moveUp(project, issue));
        case 'retry': {
          if (isCurrent) return done(`${ref} kører allerede.`, true);
          if (command.runner && !this.#deps.knownRunners.includes(command.runner)) {
            return done(
              `Runneren "${command.runner}" findes ikke. Kendte: ${this.#deps.knownRunners.join(', ')}.`,
              true,
            );
          }
          const latest = store.findLatestRun(project.name, issue);
          const override = store.getWorkflowOverride(project.name, issue);
          if (
            latest &&
            latest.status !== 'done' &&
            latest.status !== 'active' &&
            (!override || override === latest.workflow)
          ) {
            Object.assign(latest, { ladderIndex: 0, ladderUsed: 0, turnDone: false, gateIndex: 0 });
            if (command.runner) latest.overrides.runner = command.runner;
            delete latest.waitingSince;
            this.#saveStatus(latest, 'active');
            await github.removeLabel(project.repo, issue, LABELS.blocked);
            await github.removeLabel(project.repo, issue, LABELS.needsYou);
            return done(`${ref} prøves igen${command.runner ? ` på ${command.runner}` : ''}.`);
          }
          if (latest && (latest.status === 'stopped' || latest.status === 'waiting')) {
            this.#saveStatus(latest, 'blocked', `Erstattet af workflowet "${override ?? '?'}".`);
          }
          if (latest?.status === 'active') return done(`${ref} er allerede i kø.`, true);
          const run = await engine.start(project.name, issue);
          if (command.runner) {
            run.overrides.runner = command.runner;
            store.saveRun(run);
          }
          return done(`${ref} startes med workflowet "${run.workflow}".`);
        }
        case 'workflow': {
          const name = command.workflow ?? '';
          const workflows = await this.#deps.library(project).loadWorkflows();
          if (!workflows.has(name)) {
            return done(
              `Workflowet "${name}" findes ikke for ${project.name}. Kendte: ${[...workflows.keys()].join(', ')}.`,
              true,
            );
          }
          store.setWorkflowOverride(project.name, issue, name);
          return done(
            `${ref} bruger workflowet "${name}" fra næste start. Brug /factory retry #${String(issue)} for at skifte nu.`,
            true,
          );
        }
        case 'reject':
          store.addDecision({
            project: project.name,
            issue,
            kind: 'reject',
            feedback: command.feedback ?? null,
          });
          return done(`Afvisningen af ${ref} bruges som feedback i næste trin.`);
        case 'approve':
          store.addDecision({ project: project.name, issue, kind: 'approve', feedback: null });
          return done(`${ref} er godkendt.`);
      }
    } catch (error) {
      return done(
        `Kommandoen fejlede: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  statusText(): string {
    const s = this.state();
    const mode = {
      running: 'kører',
      idle: 'ledig',
      paused: 'på pause',
      waiting_quota: 'venter på kvote',
      error: 'fejl',
    }[s.mode];
    const lines = [`**Tilstand:** ${mode}${s.reason ? ` (${s.reason})` : ''}`];
    if (s.focus) lines.push(`**Fokus:** ${s.focus}`);
    if (s.quotaOverrideUntil) {
      const until = formatResetTime(s.quotaOverrideUntil, {
        now: this.#deps.now(),
        ...(this.#deps.timeZone && { timeZone: this.#deps.timeZone }),
      });
      lines.push(`**Boost:** kvotereglerne er tilsidesat til ${until}.`);
    }
    lines.push(
      s.current
        ? `**Arbejder på:** ${s.current.project}#${String(s.current.issue)} ${s.current.title} – stage ${s.current.stage}, forsøg ${String(s.current.attempt)}`
        : '**Arbejder på:** intet',
    );
    const workable = s.queue.filter((q) => !q.skip);
    lines.push(
      `**Kø:** ${
        workable.length > 0
          ? workable
              .slice(0, 5)
              .map((q) => `${q.project}#${String(q.issue)}`)
              .join(', ')
          : 'tom'
      }`,
    );
    if (s.waitingForYou.length > 0) {
      lines.push(
        `**Venter på dig:** ${s.waitingForYou.map((w) => `${w.project}#${String(w.issue)} (${w.text})`).join(', ')}`,
      );
    }
    return lines.join('\n');
  }

  async #step(run: RunState): Promise<void> {
    const controller = new AbortController();
    this.#currentAbort = controller;
    const item = this.#itemFor(run);
    this.#current = {
      project: run.project,
      issue: run.issue,
      title: item?.title ?? '',
      url: item?.url ?? '',
      workflow: run.workflow,
      stage: run.stageId,
      phase: run.phase,
      attempt: run.attempt,
      since: this.#deps.now().toISOString(),
      runner: this.#deps.config.default_runner,
      steps: [],
    };
    try {
      const project = (await this.#projects()).get(run.project);
      this.#currentWorkflow = project
        ? (await this.#deps.library(project).loadWorkflows()).get(run.workflow)
        : undefined;
    } catch {
      this.#currentWorkflow = undefined;
    }
    Object.assign(this.#current, this.#progress(run));
    this.#setMode('running');
    try {
      const after = await this.#deps.engine.advance(run, controller.signal);
      if (after.status === 'done')
        await this.#moveCard(after.project, after.issue, this.#deps.config.board.status.review);
    } catch (error) {
      if (!(error instanceof QuotaExhaustedError)) throw error;
      await this.#onUsageLimit(error.message);
    } finally {
      this.#currentAbort = undefined;
      this.#current = null;
    }
    // Show what the step cost and did right away, not at the next 5-minute read.
    if (this.#mode !== 'waiting_quota') await this.#readQuota();
    await this.#refreshToday(false);
    this.#changed();
  }

  /** Today's numbers. Merges are looked up on GitHub only when `checkMerged` is set. */
  async #refreshToday(checkMerged: boolean): Promise<void> {
    const { store, github, now, timeZone } = this.#deps;
    const runs = store.listRuns(['active', 'waiting', 'stopped', 'done', 'blocked']);
    if (checkMerged) {
      const repos = this.#repos;
      for (const run of prsOpenedToday({ runs, now: now(), timeZone })) {
        const repo = repos.get(run.project);
        if (!run.pr || !repo || this.#merged.has(prKey(run))) continue;
        try {
          if (await github.isPullRequestMerged(repo, run.pr.number)) this.#merged.add(prKey(run));
        } catch {
          // A failed lookup only leaves the merged count behind until the next heartbeat.
        }
      }
    }
    const since = new Date(now().getTime() - 26 * 60 * 60_000).toISOString();
    this.#today = todayStats({
      runs,
      attempts: store.attempts({ since }),
      merged: this.#merged,
      now: now(),
      timeZone,
    });
  }

  /**
   * Checks the quota before a step. Returns true, and enters waiting_quota, when no new turn may
   * start. A turn already running is never interrupted for quota.
   */
  async #waitForQuota(): Promise<boolean> {
    if (!this.#deps.quota) return false;
    const now = this.#deps.now().getTime();
    // While waiting, read again every 5 minutes, or as soon as the wait should be over.
    const due =
      this.#mode !== 'waiting_quota' ||
      now - this.#quotaReadAt >= QUOTA_POLL_MS ||
      (this.#nextStart !== null && now >= Date.parse(this.#nextStart));
    if (due) await this.#readQuota();
    if (this.#usageLimit && now >= this.#usageLimit.until) this.#usageLimit = undefined;
    const block = latest([
      ...(this.#quota?.block ? [this.#quota.block] : []),
      ...(this.#usageLimit ? [this.#usageLimit] : []),
    ]);
    if (!block) return false;
    this.#setMode('waiting_quota', block.reason);
    this.#nextStart = block.nextStart;
    return true;
  }

  /** The safety net: Codex stopped a turn on its usage limit before the policy saw it coming. */
  async #onUsageLimit(message: string): Promise<void> {
    await this.#readQuota();
    const now = this.#deps.now().getTime();
    const snapshot = this.#quota?.snapshot;
    const nextStart =
      this.#quota?.block?.nextStart ?? (snapshot ? usageLimitResetTime(snapshot) : null);
    this.#usageLimit = {
      reason: 'Codex meldte, at kvoten er brugt op.',
      nextStart,
      until: nextStart ? Date.parse(nextStart) : now + QUOTA_POLL_MS,
    };
    this.#write(`Kvoten slap op: ${message}`);
    this.#setMode('waiting_quota', this.#usageLimit.reason);
    this.#nextStart = nextStart;
  }

  /** Reads the quota and applies the rules. A failed read lets work go on; the safety net remains. */
  async #readQuota(): Promise<void> {
    const { quota, now } = this.#deps;
    if (!quota) return;
    this.#quotaReadAt = now().getTime();
    try {
      this.#applyQuota(await quota.read());
    } catch (error) {
      this.#quota = undefined;
      this.#write(
        `Kvoten kunne ikke læses: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Applies the rules to a snapshot, from a read or a push update. */
  #applyQuota(snapshot: QuotaSnapshot): void {
    const { store, config, now, timeZone } = this.#deps;
    const saved = PacingDay.safeParse(JSON.parse(store.getSetting(SETTING.pacingDay) ?? 'null'));
    const { status, day } = evaluateQuota({
      snapshot,
      rules: config.quota,
      day: saved.success ? saved.data : undefined,
      now: now(),
      timeZone,
      override: this.#boostUntil() !== null,
    });
    if (day) store.setSetting(SETTING.pacingDay, JSON.stringify(day));
    this.#quota = status;
    this.#changed();
  }

  /** While a step runs: interrupt it on halt, and read commands (for stop and hold). */
  async #watch(): Promise<void> {
    if (!this.#currentAbort) return;
    const halt = await this.#haltReason();
    if (halt) {
      this.#write(`${halt} Afbryder det aktuelle trin.`);
      this.#currentAbort.abort();
      return;
    }
    await this.pollCommands();
  }

  /** The progress steps and effective runner of a run, from its workflow. */
  #progress(run: RunState): { runner: string; steps: CurrentWork['steps'] } {
    const workflow = this.#currentWorkflow;
    const stage = workflow?.stages[run.stageIndex];
    return {
      runner: run.overrides.runner ?? stage?.runner ?? this.#deps.config.default_runner,
      steps: workflow ? stepsFor(workflow, run) : [],
    };
  }

  /** Moves a card in Ready one place up on the board, above the Ready card before it. */
  async #moveUp(project: Project, issue: number): Promise<string> {
    const { board, config } = this.#deps;
    const items = (await board.read()).items;
    this.#boardItems = items;
    const ready = items.filter((i) => i.status === config.board.status.ready);
    const at = ready.findIndex((i) => i.repo === project.repo && i.number === issue);
    const ref = `${project.name}#${String(issue)}`;
    const card = ready[at];
    const above = ready[at - 1];
    if (!card) return `${ref} ligger ikke i "${config.board.status.ready}".`;
    if (!above) return `${ref} er allerede øverst.`;
    const before = items[items.indexOf(above) - 1];
    await board.moveAfter(card.itemId, before?.itemId ?? null);
    const queueAt = this.#queue.findIndex((q) => q.project === project.name && q.issue === issue);
    const queued = this.#queue[queueAt];
    if (queued && queueAt > 0) {
      this.#queue.splice(queueAt, 1);
      this.#queue.splice(queueAt - 1, 0, queued);
    }
    return `${ref} er rykket én plads op.`;
  }

  /** Updates the shown queue until the next board read. */
  #markHeld(repo: string, issue: number, held: boolean): void {
    const name = [...this.#repos].find(([, r]) => r === repo)?.[0];
    for (const entry of this.#queue) {
      if (entry.project === name && entry.issue === issue) entry.held = held;
    }
  }

  async #haltReason(): Promise<string | undefined> {
    const reason = await this.#findHalt();
    this.#halted = reason !== undefined;
    return reason;
  }

  async #findHalt(): Promise<string | undefined> {
    if (existsSync(this.#deps.haltFile)) return `Nødbremse: ${this.#deps.haltFile} findes.`;
    try {
      for (const project of (await this.#projects()).values()) {
        if (await this.#deps.github.hasOpenIssueWithLabel(project.repo, HALT_LABEL)) {
          return `Nødbremse: et åbent issue i ${project.repo} har labelet ${HALT_LABEL}.`;
        }
      }
    } catch (error) {
      this.#write(
        `Tjek af ${HALT_LABEL} fejlede: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }

  async #resolveProject(name: string | undefined): Promise<Project> {
    const projects = await this.#projects();
    if (name) {
      const byName = projects.get(name) ?? [...projects.values()].find((p) => p.repo === name);
      if (!byName)
        throw new Error(`ukendt projekt "${name}". Kendte: ${[...projects.keys()].join(', ')}`);
      return byName;
    }
    const focus = this.#focus;
    const focused = focus ? projects.get(focus) : undefined;
    if (focused) return focused;
    const only = projects.size === 1 ? [...projects.values()][0] : undefined;
    if (only) return only;
    throw new Error('angiv projektet, fx loge-app#12');
  }

  async #moveCard(projectName: string, issue: number, status: string): Promise<void> {
    const projects = await this.#projects();
    const repo = projects.get(projectName)?.repo;
    const item = this.#boardItems.find((i) => i.repo === repo && i.number === issue);
    if (!item) return;
    try {
      await this.#deps.board.setStatus(item.itemId, status);
      item.status = status;
    } catch (error) {
      this.#write(
        `Kunne ikke flytte ${projectName}#${String(issue)} til "${status}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #itemFor(run: Pick<RunState, 'project' | 'issue'>): BoardItem | undefined {
    const repo = this.#repos.get(run.project);
    return this.#boardItems.find((i) => i.repo === repo && i.number === run.issue);
  }

  async #projects(): Promise<Map<string, Project>> {
    const projects = await this.#deps.projects();
    this.#repos = new Map([...projects.values()].map((p) => [p.name, p.repo]));
    return projects;
  }

  #saveStatus(run: RunState, status: RunState['status'], reason?: string): void {
    run.status = status;
    if (reason) run.reason = reason;
    else delete run.reason;
    run.updatedAt = this.#deps.now().toISOString();
    this.#deps.store.saveRun(run);
  }

  #pause(reason: string): 'paused' {
    this.#setMode('paused', reason);
    return 'paused';
  }

  #setMode(mode: DaemonMode, reason?: string): void {
    if (mode !== this.#mode || reason !== this.#reason) {
      this.#write(`Tilstand: ${mode}${reason ? ` (${reason})` : ''}`);
    }
    this.#mode = mode;
    this.#reason = reason;
    if (mode !== 'waiting_quota') this.#nextStart = null;
  }

  #write(line: string): void {
    const stamped = `${this.#deps.now().toLocaleTimeString('sv-SE', this.#deps.timeZone ? { timeZone: this.#deps.timeZone } : {})} ${line}`;
    this.#log.push(stamped);
    if (this.#log.length > LOG_LINES) this.#log.shift();
    this.#deps.log?.(stamped);
    for (const listener of this.#logListeners) listener(stamped);
    this.#changed();
  }

  #changed(): void {
    for (const listener of this.#changeListeners) listener();
  }
}
