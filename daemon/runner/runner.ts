import { z } from 'zod';
import type { Workspace } from '../workspace/workspace.js';

/** What the agent must hand back at the end of a turn. Runners enforce it as structured output. */
export const AgentReport = z.object({
  status: z
    .enum(['done', 'blocked'])
    .describe('done: the task is solved. blocked: it cannot be solved without a human.'),
  summary: z.string().describe('What changed and why, in Danish, 1-5 sentences.'),
  testsRun: z.array(z.string()).describe('The exact test or check commands you ran.'),
  commitMessage: z.string().describe('One-line commit message in English, imperative mood.'),
});
export type AgentReport = z.infer<typeof AgentReport>;

export interface RunTask {
  /** Stable id for logs, for example `loge-app#12`. */
  id: string;
  role: string;
  /** The complete prompt: agent file, issue, spec, AGENTS.md and any feedback. */
  prompt: string;
  /** The git worktree the agent works in. The runner may only write here. */
  workspace: Workspace;
  /** Aborting interrupts the turn. The work so far is committed as WIP. */
  signal?: AbortSignal;
  /**
   * Set for tasks that only look, such as reviews: the sandbox is read-only, the final answer
   * follows `schema` instead of AgentReport, and nothing is committed.
   */
  readOnly?: { schema: z.ZodType };
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface RunReport {
  status: 'success' | 'failed' | 'interrupted';
  summary: string;
  testsRun: string[];
  branch: string;
  /** Commits on the branch since its base, oldest first. */
  commits: string[];
  tokens?: TokenUsage;
  /** The parsed final answer: an AgentReport, or the `readOnly.schema` result. */
  output?: unknown;
  /** Set on a failed run that stopped because the vendor's usage limit was reached. */
  quotaExhausted?: true;
}

export type RunEvent =
  | { type: 'started'; runner: string }
  | { type: 'message'; text: string }
  | { type: 'command'; command: string; exitCode: number | null; status: string }
  | { type: 'file_change'; paths: string[]; status: string }
  | { type: 'error'; message: string }
  | { type: 'report'; report: RunReport };

/**
 * One engine that can carry out an agent turn. The core only knows this interface; vendor code
 * lives in `runners/<vendor>/`. The last event of every run is `report`.
 */
export interface Runner {
  readonly name: string;
  run(task: RunTask): AsyncIterable<RunEvent>;
}

/**
 * Thrown by the engine when a turn hits the vendor's usage limit. The run is left as it was, so
 * the step is taken again once the quota allows; the failure never counts against the ladder.
 */
export class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
  }
}
