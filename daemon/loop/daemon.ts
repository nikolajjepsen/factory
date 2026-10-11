import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { FactoryConfig } from '../config/factoryConfig.js';
import type { Project } from '../config/projects.js';
import { type Command, parseChatOps } from '../control/commands.js';
import type { Board, BoardItem } from '../github/board.js';
import { FACTORY_COMMENT_MARKER, type GitHub } from '../github/github.js';
import type { Store } from '../store/store.js';
import { type EngineEvent, LABELS, type WorkflowEngine } from '../workflow/engine.js';
import type { AgentLibrary } from '../workflow/load.js';
import type { RunState } from '../workflow/runState.js';
import { HOLD_LABEL, pickNext } from './picker.js';
import type { DaemonMode, FactoryState, QueueEntry, WaitingEntry } from './state.js';
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

export interface CommandResult {
  text: string;
  /** Whether the text is worth a reply comment (status, errors, notes); otherwise a +1 is enough. */
  reply: boolean;
}

const SETTING = { paused: 'paused', focus: 'focus', commentsSince: 'comments_since' } as const;
const LOG_LINES = 50;
/** How far back the first comment poll looks, so old commands are not replayed. */
const FIRST_POLL_LOOKBACK_MS = 10 * 60_000;
/** Overlap between polls; handled comment ids make it safe. */
const POLL_OVERLAP_MS = 2 * 60_000;
const DONE_VISIBLE_MS = 7 * 24 * 60 * 60_000;

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
      ...(this.#reason && { reason: this.#reason }),
      heartbeat: now().toISOString(),
      nextStart: null,
      focus: this.#focus,
      current: this.#current,
      queue: this.#queue,
      waitingForYou: waiting,
      log: [...this.#log],
    };
  }

  /** Feeds engine events into the log and the "working on" status. */
  handleEngineEvent(event: EngineEvent): void {
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
  async tick(): Promise<'worked' | 'idle' | 'paused'> {
    const { store, engine, board, config } = this.#deps;
    await this.pollCommands();
    const halt = await this.#haltReason();
    if (halt) return this.#pause(halt);
    if (this.#paused) return this.#pause('Sat på pause med /factory pause.');

    for (const run of store.listRuns(['waiting'])) {
      await engine.advance(run);
    }
    const active = store.listRuns(['active'])[0];
    if (active) {
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
    await this.#moveCard(next.project, next.issue, config.board.status.in_progress);
    const run = await engine.start(next.project, next.issue);
    await this.#step(run);
    return 'worked';
  }

  /** Runs until the signal aborts. Heartbeat and the halt watch run on their own timers. */
  async run(signal: AbortSignal): Promise<void> {
    const { idleMs = 60_000, heartbeatMs = 60_000, watchMs = 30_000 } = this.#deps;
    this.#write('Daemonen starter.');
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
          await this.#deps.sleep(idleMs, signal).catch(() => undefined);
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(watch);
      signal.removeEventListener('abort', onAbort);
      this.#write('Daemonen stopper.');
      await this.heartbeat();
    }
  }

  async heartbeat(): Promise<void> {
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
            this.#write(`Kommando /factory ${command.command}: ${result.text}`);
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

  /** The single control system: ChatOps now, the daemon API from M5a. */
  async execute(command: Command): Promise<CommandResult> {
    const { store, github, engine } = this.#deps;
    const done = (text: string, reply = false): CommandResult => ({ text, reply });
    try {
      switch (command.command) {
        case 'pause':
          store.setSetting(SETTING.paused, 'true');
          return done(
            this.#currentAbort
              ? 'Holder pause efter det aktuelle trin.'
              : 'Fabrikken holder pause.',
          );
        case 'resume': {
          store.setSetting(SETTING.paused, undefined);
          const halt = await this.#haltReason();
          return halt
            ? done(`Genoptaget, men nødbremsen er stadig aktiv: ${halt}`, true)
            : done('Fabrikken kører igen.');
        }
        case 'halt':
          await writeFile(this.#deps.haltFile, `Nødbremse sat ${this.#deps.now().toISOString()}\n`);
          this.#currentAbort?.abort();
          this.#pause(`Nødbremse: ${this.#deps.haltFile} findes.`);
          return done(
            `Nødbremse aktiveret. Slet ${this.#deps.haltFile} og skriv /factory resume for at fortsætte.`,
            true,
          );
        case 'status':
          return done(this.statusText(), true);
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
          if (isCurrent) this.#currentAbort?.abort();
          const open = store.findOpenRun(project.name, issue);
          if (open && !isCurrent) this.#saveStatus(open, 'stopped', 'Sat på hold.');
          return done(`${ref} er sat på hold. Fjern labelet ${HOLD_LABEL} for at frigive det.`);
        }
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
    };
    this.#setMode('running');
    try {
      const after = await this.#deps.engine.advance(run, controller.signal);
      if (after.status === 'done')
        await this.#moveCard(after.project, after.issue, this.#deps.config.board.status.review);
    } finally {
      this.#currentAbort = undefined;
      this.#current = null;
    }
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

  async #haltReason(): Promise<string | undefined> {
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
  }

  #write(line: string): void {
    const stamped = `${this.#deps.now().toLocaleTimeString('sv-SE', this.#deps.timeZone ? { timeZone: this.#deps.timeZone } : {})} ${line}`;
    this.#log.push(stamped);
    if (this.#log.length > LOG_LINES) this.#log.shift();
    this.#deps.log?.(stamped);
  }
}
