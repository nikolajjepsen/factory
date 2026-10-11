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
  /** When work resumes, if the factory is waiting (M4 fills this for waiting_quota). */
  nextStart: string | null;
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
