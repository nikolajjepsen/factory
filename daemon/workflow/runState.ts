import type { Phase, Strategy } from './schema.js';

/**
 * - `active`: the engine has work to do on the next advance.
 * - `waiting`: parked on a human gate; the daemon moves on and checks back.
 * - `stopped`: interrupted (`/factory stop`, Ctrl-C, halt). `factory run` or `/factory retry` resumes it.
 * - `done`: every stage passed; the PR is labelled `factory:ready-to-merge`.
 * - `blocked`: the escalation ladder ran out; the issue is labelled `factory:blocked`.
 */
export type RunStatus = 'active' | 'waiting' | 'stopped' | 'done' | 'blocked';

/** Everything the engine needs to continue a run after a restart. Stored as JSON in SQLite. */
export interface RunState {
  id: string;
  project: string;
  issue: number;
  workflow: string;
  status: RunStatus;
  /** Fixed when the run starts, so renaming the issue does not move the work. */
  branch: string;
  stageIndex: number;
  /** The id of the current stage, for status displays. */
  stageId: string;
  phase: Phase;
  /** 1-based attempt number within the current stage. */
  attempt: number;
  /** Position on the current stage's escalation ladder, and how often that rung was used. */
  ladderIndex: number;
  ladderUsed: number;
  overrides: { strategy?: Strategy; runner?: string; agent?: string };
  /** Feedback gathered in the current stage; every rerun gets all of it. */
  feedback: string[];
  /** Whether the agent turn of the current phase attempt is done (gates come next). */
  turnDone: boolean;
  /** Gates of the current phase already passed in this attempt. */
  gateIndex: number;
  /** When the run started waiting on a human gate. */
  waitingSince?: string;
  /** `openedAt` is unset for PRs opened before M5a. */
  pr?: { number: number; url: string; openedAt?: string };
  /** The last agent summary, for the PR body and notifications. */
  lastSummary?: string;
  /** Why the run is blocked or stopped, in Danish. */
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export const OPEN_STATUSES: readonly RunStatus[] = ['active', 'waiting', 'stopped'];
