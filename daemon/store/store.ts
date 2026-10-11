import Database from 'better-sqlite3';
import { OPEN_STATUSES, type RunState, type RunStatus } from '../workflow/runState.js';

/** One agent turn or one gate result. This is the data M7b learns from. */
export interface AttemptRecord {
  runId: string;
  project: string;
  issue: number;
  stage: string;
  attempt: number;
  phase: string;
  agent: string;
  runner: string;
  strategy: string;
  /** null for the agent turn itself; otherwise `ci`, `review`, `human` or `reject`. */
  gate: string | null;
  score: number | null;
  passed: boolean;
  feedback: string | null;
  tokens: number | null;
  durationMs: number;
}

export interface Decision {
  id: number;
  project: string;
  issue: number;
  kind: 'approve' | 'reject';
  feedback: string | null;
}

/** The daemon's durable state. Synchronous: better-sqlite3 is, and the factory runs one thing at a time. */
export interface Store {
  saveRun(run: RunState): void;
  getRun(id: string): RunState | undefined;
  /** The run for an issue that is active, waiting or stopped, if any. */
  findOpenRun(project: string, issue: number): RunState | undefined;
  listRuns(statuses: readonly RunStatus[]): RunState[];
  logAttempt(record: AttemptRecord): void;
  attempts(filter: {
    runId?: string;
    project?: string;
    issue?: number;
  }): (AttemptRecord & { createdAt: string })[];
  addDecision(decision: Omit<Decision, 'id'>): void;
  /** Takes (and marks as used) the oldest unused decision of this kind for the issue. */
  takeDecision(project: string, issue: number, kind: Decision['kind']): Decision | undefined;
  setWorkflowOverride(project: string, issue: number, workflow: string): void;
  getWorkflowOverride(project: string, issue: number): string | undefined;
  /** The newest run for an issue, whatever its status. */
  findLatestRun(project: string, issue: number): RunState | undefined;
  /** Small daemon settings that must survive restarts: pause, focus, last comment poll. */
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string | undefined): void;
  /** Records a ChatOps comment as handled. Returns false if it was handled before. */
  markCommentHandled(repo: string, commentId: number): boolean;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  issue INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_issue ON runs (project, issue);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  project TEXT NOT NULL,
  issue INTEGER NOT NULL,
  stage TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  phase TEXT NOT NULL,
  agent TEXT NOT NULL,
  runner TEXT NOT NULL,
  strategy TEXT NOT NULL,
  gate TEXT,
  score REAL,
  passed INTEGER NOT NULL,
  feedback TEXT,
  tokens INTEGER,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_run ON attempts (run_id);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  issue INTEGER NOT NULL,
  kind TEXT NOT NULL,
  feedback TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS handled_comments (
  repo TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  handled_at TEXT NOT NULL,
  PRIMARY KEY (repo, comment_id)
);
CREATE TABLE IF NOT EXISTS workflow_overrides (
  project TEXT NOT NULL,
  issue INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  PRIMARY KEY (project, issue)
);
`;

interface AttemptRow {
  run_id: string;
  project: string;
  issue: number;
  stage: string;
  attempt: number;
  phase: string;
  agent: string;
  runner: string;
  strategy: string;
  gate: string | null;
  score: number | null;
  passed: number;
  feedback: string | null;
  tokens: number | null;
  duration_ms: number;
  created_at: string;
}

export class SqliteStore implements Store {
  readonly #db: Database.Database;
  readonly #now: () => Date;

  /** `path` is a file, or `:memory:` for tests. */
  constructor(path: string, now: () => Date = () => new Date()) {
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(SCHEMA);
    this.#now = now;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  saveRun(run: RunState): void {
    this.#db
      .prepare(
        `INSERT INTO runs (id, project, issue, workflow, status, state, created_at, updated_at)
         VALUES (@id, @project, @issue, @workflow, @status, @state, @createdAt, @updatedAt)
         ON CONFLICT (id) DO UPDATE SET workflow = @workflow, status = @status, state = @state, updated_at = @updatedAt`,
      )
      .run({ ...run, state: JSON.stringify(run) });
  }

  getRun(id: string): RunState | undefined {
    const row = this.#db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as
      { state: string } | undefined;
    return row ? (JSON.parse(row.state) as RunState) : undefined;
  }

  findOpenRun(project: string, issue: number): RunState | undefined {
    const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
    const row = this.#db
      .prepare(
        `SELECT state FROM runs WHERE project = ? AND issue = ? AND status IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(project, issue, ...OPEN_STATUSES) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as RunState) : undefined;
  }

  listRuns(statuses: readonly RunStatus[]): RunState[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`SELECT state FROM runs WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...statuses) as { state: string }[];
    return rows.map((row) => JSON.parse(row.state) as RunState);
  }

  logAttempt(record: AttemptRecord): void {
    this.#db
      .prepare(
        `INSERT INTO attempts (run_id, project, issue, stage, attempt, phase, agent, runner, strategy, gate,
           score, passed, feedback, tokens, duration_ms, created_at)
         VALUES (@runId, @project, @issue, @stage, @attempt, @phase, @agent, @runner, @strategy, @gate,
           @score, @passed, @feedback, @tokens, @durationMs, @createdAt)`,
      )
      .run({ ...record, passed: record.passed ? 1 : 0, createdAt: this.#timestamp() });
  }

  attempts(filter: { runId?: string; project?: string; issue?: number }) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.runId !== undefined) {
      where.push('run_id = ?');
      params.push(filter.runId);
    }
    if (filter.project !== undefined) {
      where.push('project = ?');
      params.push(filter.project);
    }
    if (filter.issue !== undefined) {
      where.push('issue = ?');
      params.push(filter.issue);
    }
    const sql = `SELECT * FROM attempts ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
    return (this.#db.prepare(sql).all(...params) as AttemptRow[]).map((row) => ({
      runId: row.run_id,
      project: row.project,
      issue: row.issue,
      stage: row.stage,
      attempt: row.attempt,
      phase: row.phase,
      agent: row.agent,
      runner: row.runner,
      strategy: row.strategy,
      gate: row.gate,
      score: row.score,
      passed: row.passed === 1,
      feedback: row.feedback,
      tokens: row.tokens,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));
  }

  addDecision(decision: Omit<Decision, 'id'>): void {
    this.#db
      .prepare(
        'INSERT INTO decisions (project, issue, kind, feedback, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(decision.project, decision.issue, decision.kind, decision.feedback, this.#timestamp());
  }

  takeDecision(project: string, issue: number, kind: Decision['kind']): Decision | undefined {
    const take = this.#db.transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT id, project, issue, kind, feedback FROM decisions
           WHERE project = ? AND issue = ? AND kind = ? AND used_at IS NULL ORDER BY id LIMIT 1`,
        )
        .get(project, issue, kind) as Decision | undefined;
      if (row)
        this.#db
          .prepare('UPDATE decisions SET used_at = ? WHERE id = ?')
          .run(this.#timestamp(), row.id);
      return row;
    });
    return take();
  }

  setWorkflowOverride(project: string, issue: number, workflow: string): void {
    this.#db
      .prepare(
        `INSERT INTO workflow_overrides (project, issue, workflow) VALUES (?, ?, ?)
         ON CONFLICT (project, issue) DO UPDATE SET workflow = excluded.workflow`,
      )
      .run(project, issue, workflow);
  }

  getWorkflowOverride(project: string, issue: number): string | undefined {
    const row = this.#db
      .prepare('SELECT workflow FROM workflow_overrides WHERE project = ? AND issue = ?')
      .get(project, issue) as { workflow: string } | undefined;
    return row?.workflow;
  }

  findLatestRun(project: string, issue: number): RunState | undefined {
    const row = this.#db
      .prepare(
        'SELECT state FROM runs WHERE project = ? AND issue = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(project, issue) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as RunState) : undefined;
  }

  getSetting(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) this.#db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else
      this.#db
        .prepare(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value);
  }

  markCommentHandled(repo: string, commentId: number): boolean {
    const result = this.#db
      .prepare(
        'INSERT OR IGNORE INTO handled_comments (repo, comment_id, handled_at) VALUES (?, ?, ?)',
      )
      .run(repo, commentId, this.#timestamp());
    return result.changes > 0;
  }

  close(): void {
    this.#db.close();
  }
}
