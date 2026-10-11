import { z } from 'zod';
import { type CheckRun, FACTORY_COMMENT_MARKER, type GitHub } from '../github/github.js';
import {
  QuotaExhaustedError,
  type RunEvent,
  type Runner,
  type RunTask,
  type TokenUsage,
} from '../runner/runner.js';
import type { Store } from '../store/store.js';
import type { RunState } from './runState.js';
import type { Gate } from './schema.js';

export type GateResult =
  /** `answer`: the owner's reply from a `human: answer` gate, handed to the next stages. */
  | { kind: 'pass'; score?: number; feedback?: string; tokens?: TokenUsage; answer?: string }
  | { kind: 'fail'; feedback: string; score?: number; tokens?: TokenUsage }
  | { kind: 'pending' };

/** Thrown when a gate is cut short by the run's AbortSignal. The engine stops the run. */
export class GateAborted extends Error {
  constructor() {
    super('gate aborted');
    this.name = 'GateAborted';
  }
}

// ---------------------------------------------------------------------------------------------
// ci: wait for the PR's checks on the pushed sha.

export interface CiOptions {
  github: GitHub;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => Date;
  pollMs: number;
  timeoutMs: number;
  /** How long to wait for the first check to show up after a push. */
  noChecksGraceMs: number;
}

const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const LOG_LINES = 60;
const LOG_CHARS = 4000;

/** The useful tail of an Actions log: timestamps and ANSI codes removed, error lines kept. */
export function excerptLog(log: string): string {
  const lines = log
    .split('\n')
    // eslint-disable-next-line no-control-regex -- ANSI escape codes are control characters.
    .map((line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\x1b\[[0-9;]*m/g, ''))
    .filter((line) => line.trim() !== '');
  const errors = lines.filter((line) => line.startsWith('##[error]'));
  const tail = lines.slice(-LOG_LINES).filter((line) => !errors.includes(line));
  const text = [...tail, ...errors].join('\n');
  return text.length > LOG_CHARS ? `…\n${text.slice(-LOG_CHARS)}` : text;
}

async function describeFailedRun(github: GitHub, repo: string, run: CheckRun): Promise<string> {
  const head = `- ${run.name}: ${run.conclusion ?? 'ukendt'}${run.html_url ? ` (${run.html_url})` : ''}`;
  if (run.app?.slug !== 'github-actions') return head;
  try {
    const log = excerptLog(await github.getJobLog(repo, run.id));
    return log ? `${head}\n\n\`\`\`\n${log}\n\`\`\`` : head;
  } catch {
    return head;
  }
}

export async function evaluateCi(
  options: CiOptions,
  repo: string,
  sha: string,
  signal?: AbortSignal,
): Promise<GateResult> {
  const { github, now } = options;
  const started = now().getTime();
  for (;;) {
    if (signal?.aborted) throw new GateAborted();
    const [runs, statuses] = await Promise.all([
      github.listCheckRuns(repo, sha),
      github.listCommitStatuses(repo, sha),
    ]);
    const elapsed = now().getTime() - started;
    if (runs.length + statuses.length === 0) {
      if (elapsed >= options.noChecksGraceMs) {
        return {
          kind: 'fail',
          feedback: `Ingen CI-tjek blev rapporteret for ${sha.slice(0, 7)} inden for ${String(Math.round(options.noChecksGraceMs / 60_000))} min.`,
        };
      }
    } else {
      const pending =
        runs.some((r) => r.status !== 'completed') || statuses.some((s) => s.state === 'pending');
      if (!pending) {
        const failedRuns = runs.filter((r) => !OK_CONCLUSIONS.has(r.conclusion ?? ''));
        const failedStatuses = statuses.filter((s) => s.state === 'failure' || s.state === 'error');
        if (failedRuns.length + failedStatuses.length === 0) return { kind: 'pass' };
        const parts = [
          ...(await Promise.all(failedRuns.map((r) => describeFailedRun(github, repo, r)))),
          ...failedStatuses.map(
            (s) => `- ${s.context}: ${s.state}${s.description ? ` – ${s.description}` : ''}`,
          ),
        ];
        return { kind: 'fail', feedback: `CI fejlede:\n${parts.join('\n')}` };
      }
      if (elapsed >= options.timeoutMs) {
        return {
          kind: 'fail',
          feedback: `CI blev ikke færdig inden for ${String(Math.round(options.timeoutMs / 60_000))} min.`,
        };
      }
    }
    try {
      await options.sleep(options.pollMs, signal);
    } catch {
      throw new GateAborted();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// review: a read-only agent scores the change against a rubric.

export const ReviewResult = z.object({
  score: z.number().min(0).max(10).describe('0-10. 7 means "I would merge this".'),
  passed: z.boolean().describe('True if you would merge the change as it is.'),
  feedback: z.array(z.string()).describe('Concrete things to fix, in Danish. Empty if none.'),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export async function evaluateReview(
  runner: Runner,
  task: Omit<RunTask, 'readOnly'>,
  gate: Extract<Gate, { kind: 'review' }>,
  onEvent?: (event: RunEvent) => void,
): Promise<GateResult> {
  let report;
  for await (const event of runner.run({ ...task, readOnly: { schema: ReviewResult } })) {
    onEvent?.(event);
    if (event.type === 'report') report = event.report;
  }
  if (!report || report.status === 'interrupted') throw new GateAborted();
  if (report.quotaExhausted) throw new QuotaExhaustedError(report.summary);
  const tokens = report.tokens ? { tokens: report.tokens } : {};
  if (report.status === 'failed') {
    return {
      kind: 'fail',
      feedback: `Review kunne ikke gennemføres: ${report.summary}`,
      ...tokens,
    };
  }
  const review = ReviewResult.parse(report.output);
  const feedback = review.feedback.map((item) => `- ${item}`).join('\n');
  if (review.passed && review.score >= gate.minScore) {
    return { kind: 'pass', score: review.score, ...(feedback && { feedback }), ...tokens };
  }
  const verdict = `Review gav ${String(review.score)}/10 (kræver ${String(gate.minScore)}${review.passed ? '' : ' og godkendt'}).`;
  return {
    kind: 'fail',
    score: review.score,
    feedback: feedback ? `${verdict}\n${feedback}` : verdict,
    ...tokens,
  };
}

// ---------------------------------------------------------------------------------------------
// human: wait for Nikolaj.

export interface HumanOptions {
  github: GitHub;
  store: Store;
  ownerLogin: string;
}

/**
 * Waits for the owner, counting only what happened after the latest turn or the start of waiting:
 * - every mode passes on `/factory approve` (for `answer`: follow the recommendations),
 * - `approve_pr` and `merge` fail on a review that requests changes, with its text as feedback,
 * - `approve_pr` passes on an approving review, `merge` once the run's PR is merged,
 * - `answer` passes on the owner's first comment on the issue that is more than commands.
 */
export async function evaluateHuman(
  options: HumanOptions,
  gate: Extract<Gate, { kind: 'human' }>,
  repo: string,
  run: RunState,
): Promise<GateResult> {
  const { github, store, ownerLogin } = options;
  // Only answers given after the latest turn count: a review that asked for changes must not
  // fail the turn that made those changes.
  const since = [run.waitingSince, run.turnFinishedAt, run.createdAt]
    .filter((t): t is string => t !== undefined)
    .reduce((a, b) => (a > b ? a : b));
  if (store.takeDecision(run.project, run.issue, 'approve')) {
    return gate.mode === 'answer'
      ? { kind: 'pass', answer: `${ownerLogin} godkendte alle anbefalinger uden ændringer.` }
      : { kind: 'pass' };
  }
  if (gate.mode === 'answer') {
    const reply = (await github.listCommentsSince(repo, since))
      .filter((c) => c.issueNumber === run.issue && c.author === ownerLogin)
      .filter((c) => c.createdAt > since && !c.body.includes(FACTORY_COMMENT_MARKER))
      .map((c) => withoutCommands(c.body))
      .find((text) => text !== '');
    return reply === undefined ? { kind: 'pending' } : { kind: 'pass', answer: reply };
  }
  if ((gate.mode === 'approve_pr' || gate.mode === 'merge') && run.pr) {
    const reviews = (await github.listReviews(repo, run.pr.number))
      .filter((r) => r.user?.login === ownerLogin && (r.submitted_at ?? '') > since)
      .filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED');
    const latest = reviews.at(-1);
    if (latest?.state === 'CHANGES_REQUESTED') {
      const body = latest.body?.trim() ?? '';
      return {
        kind: 'fail',
        feedback: `${ownerLogin} bad om ændringer: ${body === '' ? '(ingen tekst)' : body}`,
      };
    }
    if (gate.mode === 'approve_pr' && latest?.state === 'APPROVED') return { kind: 'pass' };
    if (gate.mode === 'merge' && (await github.isPullRequestMerged(repo, run.pr.number))) {
      return { kind: 'pass' };
    }
  }
  return { kind: 'pending' };
}

/** A comment without its `/factory` lines, trimmed. */
function withoutCommands(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('/factory'))
    .join('\n')
    .trim();
}
