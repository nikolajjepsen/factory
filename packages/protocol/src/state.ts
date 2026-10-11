import { z } from 'zod';
import { PacingStatus, QuotaSnapshot } from './quota.js';

/**
 * The daemon is always in one of these modes. `offline` is not a mode the daemon reports: readers
 * derive it when the heartbeat is older than 5 minutes.
 */
export const DaemonMode = z.enum(['running', 'idle', 'paused', 'waiting_quota', 'error']);
export type DaemonMode = z.infer<typeof DaemonMode>;

export const OFFLINE_AFTER_MS = 5 * 60_000;

export const QueueEntry = z.object({
  project: z.string(),
  issue: z.number(),
  title: z.string(),
  url: z.string(),
  /** Why the daemon passes over this card, in Danish. Unset for workable cards. */
  skip: z.string().optional(),
  /** The card has `factory:hold`; `release` frees it. */
  held: z.boolean(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

export const WaitingEntry = z.object({
  project: z.string(),
  issue: z.number(),
  kind: z.enum(['needs-you', 'blocked', 'ready-to-merge']),
  text: z.string(),
  url: z.string().optional(),
});
export type WaitingEntry = z.infer<typeof WaitingEntry>;

/** One box in the "working on" progress bar: an agent turn or a gate. */
export const Step = z.object({
  label: z.string(),
  state: z.enum(['done', 'active', 'pending']),
});
export type Step = z.infer<typeof Step>;

export const CurrentWork = z.object({
  project: z.string(),
  issue: z.number(),
  title: z.string(),
  url: z.string(),
  workflow: z.string(),
  stage: z.string(),
  phase: z.string(),
  attempt: z.number(),
  since: z.string(),
  runner: z.string(),
  /** Every agent turn and gate of the workflow, in order. Empty if the workflow is unknown. */
  steps: z.array(Step),
});
export type CurrentWork = z.infer<typeof CurrentWork>;

/** Today's numbers, as in the control room's log header: "4 PR'er · 2 merged · first-pass 71 %". */
export const TodayStats = z.object({
  /** Pull requests the factory opened today. */
  prs: z.number(),
  /** Of those, how many are merged. */
  merged: z.number(),
  /** Share of stages finished today that passed on their first attempt, 0–100. Null: none. */
  firstPass: z.number().nullable(),
});
export type TodayStats = z.infer<typeof TodayStats>;

/** What the daemon shows the world: `GET /state`, the SSE stream and the status issue. */
export const FactoryState = z.object({
  mode: DaemonMode,
  /** Why the factory is paused, waiting or in error, in Danish. */
  reason: z.string().nullable(),
  /** The daemon's latest heartbeat. */
  heartbeat: z.iso.datetime(),
  /** When work resumes, while the mode is waiting_quota. Null when the reset time is unknown. */
  nextStart: z.iso.datetime().nullable(),
  /** The latest quota reading and today's pacing budget. Null until the quota is read. */
  quota: z.object({ snapshot: QuotaSnapshot, pacing: PacingStatus.optional() }).nullable(),
  /** Until when `/factory boost` sets the quota rules aside. Codex' own limit still applies. */
  quotaOverrideUntil: z.iso.datetime().nullable(),
  focus: z.string().nullable(),
  /** The projects in projects.yml. A disabled project gets no new steps. */
  projects: z.array(z.object({ name: z.string(), repo: z.string(), enabled: z.boolean() })),
  /** Runners this daemon can use, for "switch runner". */
  runners: z.array(z.string()),
  /** The emergency brake is on (`~/.ai-factory/HALT` or a `factory:halt` label). */
  halted: z.boolean(),
  current: CurrentWork.nullable(),
  queue: z.array(QueueEntry),
  waitingForYou: z.array(WaitingEntry),
  today: TodayStats,
  /** The latest log lines, newest last. */
  log: z.array(z.string()),
});
export type FactoryState = z.infer<typeof FactoryState>;

export function isOffline(state: Pick<FactoryState, 'heartbeat'>, now: Date): boolean {
  return now.getTime() - new Date(state.heartbeat).getTime() > OFFLINE_AFTER_MS;
}
