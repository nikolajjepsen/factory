import type { TodayStats } from '@ai-factory/protocol';
import { localDate } from '../quota/policy.js';
import type { RunState } from '../workflow/runState.js';

export interface TodayInput {
  runs: readonly RunState[];
  /** Attempts logged in the last day or so; only today's (local date) are used. */
  attempts: readonly {
    runId: string;
    stage: string;
    attempt: number;
    passed: boolean;
    createdAt: string;
  }[];
  /** `project#pr` of PRs known to be merged. */
  merged: ReadonlySet<string>;
  now: Date;
  timeZone?: string | undefined;
}

/** The PRs the factory opened today (local date). */
export function prsOpenedToday(input: Pick<TodayInput, 'runs' | 'now' | 'timeZone'>): RunState[] {
  const today = localDate(input.now, input.timeZone);
  return input.runs.filter(
    (run) => run.pr?.openedAt && localDate(new Date(run.pr.openedAt), input.timeZone) === today,
  );
}

export const prKey = (run: RunState): string => `${run.project}#${String(run.pr?.number ?? 0)}`;

/**
 * "4 PR'er · 2 merged · first-pass 71 %". First-pass counts the stages (per run) with attempts
 * today that are finished: the run moved past the stage, or its last attempt passed and the run
 * is no longer working on it. A stage passed on first try never got past attempt 1.
 */
export function todayStats(input: TodayInput): TodayStats {
  const opened = prsOpenedToday(input);
  const today = localDate(input.now, input.timeZone);
  const runs = new Map(input.runs.map((run) => [run.id, run]));
  const stages = new Map<
    string,
    { run: RunState | undefined; stage: string; maxAttempt: number; lastPassed: boolean }
  >();
  for (const attempt of input.attempts) {
    if (localDate(new Date(attempt.createdAt), input.timeZone) !== today) continue;
    const key = `${attempt.runId}\u0000${attempt.stage}`;
    const entry = stages.get(key) ?? {
      run: runs.get(attempt.runId),
      stage: attempt.stage,
      maxAttempt: 0,
      lastPassed: false,
    };
    entry.maxAttempt = Math.max(entry.maxAttempt, attempt.attempt);
    entry.lastPassed = attempt.passed;
    stages.set(key, entry);
  }
  let finished = 0;
  let firstTry = 0;
  for (const { run, stage, maxAttempt, lastPassed } of stages.values()) {
    const stillOnIt =
      run !== undefined &&
      (run.status === 'active' || run.status === 'waiting') &&
      run.stageId === stage;
    if (!lastPassed || stillOnIt) continue;
    finished++;
    if (maxAttempt === 1) firstTry++;
  }
  return {
    prs: opened.length,
    merged: opened.filter((run) => input.merged.has(prKey(run))).length,
    firstPass: finished === 0 ? null : Math.round((firstTry / finished) * 100),
  };
}
