import { finishRun } from '../../daemon/runner/finishRun.js';
import type { AgentReport, RunEvent, Runner, RunTask } from '../../daemon/runner/runner.js';
import type { FakeWorkspace } from './fakeWorkspace.js';

export interface ScriptedTurn {
  /** For write tasks: the agent's report. Defaults to a successful one. */
  report?: Partial<AgentReport>;
  /** For read-only tasks: the final answer (for example a review). */
  output?: unknown;
  /** Make the turn fail as a runner error. */
  error?: string;
  /** Make the turn fail on the vendor's usage limit. */
  quota?: boolean;
  /** Whether the turn leaves changes to commit. Defaults to true for write tasks. */
  changes?: boolean;
  /** Simulate an interrupt. */
  interrupted?: boolean;
}

/** A runner that plays scripted turns in order and records every task it was given. */
export class ScriptRunner implements Runner {
  readonly tasks: RunTask[] = [];
  readonly turns: ScriptedTurn[] = [];

  constructor(readonly name = 'codex') {}

  /** Queues turns. When the queue is empty, write tasks succeed and reviews pass with 9. */
  script(...turns: ScriptedTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  get writeTasks(): RunTask[] {
    return this.tasks.filter((t) => !t.readOnly);
  }

  get reviewTasks(): RunTask[] {
    return this.tasks.filter((t) => t.readOnly);
  }

  async *run(task: RunTask): AsyncIterable<RunEvent> {
    this.tasks.push(task);
    yield { type: 'started', runner: this.name };
    const turn = this.turns.shift() ?? {};
    const workspace = task.workspace as FakeWorkspace;
    if (turn.interrupted || task.signal?.aborted) {
      yield { type: 'report', report: await finishRun(task, { kind: 'interrupted' }) };
      return;
    }
    if (turn.quota) {
      workspace.dirty = turn.changes ?? true;
      yield {
        type: 'report',
        report: await finishRun(task, {
          kind: 'failed',
          error: 'Codex-turnen fejlede: usage limit',
          quotaExhausted: true,
        }),
      };
      return;
    }
    if (turn.error !== undefined) {
      yield {
        type: 'report',
        report: await finishRun(task, { kind: 'failed', error: turn.error }),
      };
      return;
    }
    if (task.readOnly) {
      const output = turn.output ?? { score: 9, passed: true, feedback: [] };
      yield { type: 'report', report: await finishRun(task, { kind: 'completed', output }) };
      return;
    }
    workspace.dirty = turn.changes ?? true;
    const report: AgentReport = {
      status: 'done',
      summary: `Udført af ${task.role}.`,
      testsRun: ['npm test'],
      commitMessage: `Work by ${task.role}`,
      ...turn.report,
    };
    yield { type: 'report', report: await finishRun(task, { kind: 'completed', output: report }) };
  }
}
