import type { QuotaStatus } from '../quota/policy.js';

/**
 * The daemon is always in one of these modes. `offline` is not a mode the daemon reports: readers
 * derive it when the heartbeat is older than 5 minutes.
 */
export type DaemonMode = 'running' | 'idle' | 'paused' | 'waiting_quota' | 'error';

export const OFFLINE_AFTER_MS = 5 * 60_000;

export interface QueueEntry {
  project: string;
  issue: number;
  title: string;
  url: string;
  /** Why the daemon passes over this card, in Danish. Unset for workable cards. */
  skip?: string;
}

export interface WaitingEntry {
  project: string;
  issue: number;
  kind: 'needs-you' | 'blocked' | 'ready-to-merge';
  text: string;
  url?: string;
}

/** What the daemon shows the world: the heartbeat issue now, `GET /state` from M5a. */
export interface FactoryState {
  mode: DaemonMode;
  /** Why the factory is paused or in error, in Danish. */
  reason?: string;
  heartbeat: string;
  /** When work resumes, while the mode is waiting_quota. Null when the reset time is unknown. */
  nextStart: string | null;
  /** The latest quota reading and today's pacing budget. Null until the quota is read. */
  quota: Omit<QuotaStatus, 'block'> | null;
  /** Until when `/factory boost` sets the quota rules aside. Codex' own limit still applies. */
  quotaOverrideUntil: string | null;
  focus: string | null;
  current: {
    project: string;
    issue: number;
    title: string;
    url: string;
    workflow: string;
    stage: string;
    phase: string;
    attempt: number;
    since: string;
  } | null;
  queue: QueueEntry[];
  waitingForYou: WaitingEntry[];
  /** The latest log lines, newest last. */
  log: string[];
}

export function isOffline(state: Pick<FactoryState, 'heartbeat'>, now: Date): boolean {
  return now.getTime() - new Date(state.heartbeat).getTime() > OFFLINE_AFTER_MS;
}
