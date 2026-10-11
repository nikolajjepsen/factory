import type { BoardItem } from '../github/board.js';
import type { Project } from '../config/projects.js';
import type { QueueEntry } from './state.js';

export const HOLD_LABEL = 'factory:hold';
export const BLOCKED_LABEL = 'factory:blocked';

export interface PickContext {
  readyStatus: string;
  /** Projects by repo (`owner/repo`). */
  projectsByRepo: ReadonlyMap<string, Project>;
  focus: string | null;
  /** Whether the factory already has a run for this issue that should not be restarted. */
  hasRun: (project: string, issue: number) => boolean;
}

/**
 * Looks at the "ready" column in board order and returns the queue with a reason for every card
 * the daemon passes over, and the first card it can work on. The board decides priority; the
 * daemon never reorders.
 */
export function pickNext(
  items: readonly BoardItem[],
  ctx: PickContext,
): { queue: QueueEntry[]; next?: QueueEntry } {
  const queue: QueueEntry[] = [];
  let next: QueueEntry | undefined;
  for (const item of items) {
    if (item.status !== ctx.readyStatus) continue;
    const project = ctx.projectsByRepo.get(item.repo);
    const entry: QueueEntry = {
      project: project?.name ?? item.repo,
      issue: item.number,
      title: item.title,
      url: item.url,
    };
    const skip = !item.open
      ? 'lukket'
      : !project
        ? `${item.repo} er ikke i projects.yml`
        : ctx.focus && project.name !== ctx.focus
          ? `fokus er på ${ctx.focus}`
          : item.labels.includes(HOLD_LABEL)
            ? HOLD_LABEL
            : item.labels.includes(BLOCKED_LABEL)
              ? `${BLOCKED_LABEL} (brug /factory retry)`
              : item.openSubIssues.length > 0
                ? `venter på sub-issues ${item.openSubIssues.map((n) => `#${String(n)}`).join(', ')}`
                : item.openBlockers.length > 0
                  ? `blokeret af ${item.openBlockers.join(', ')}`
                  : ctx.hasRun(project.name, item.number)
                    ? 'har allerede en kørsel'
                    : undefined;
    if (skip) entry.skip = skip;
    else next ??= entry;
    queue.push(entry);
  }
  return next ? { queue, next } : { queue };
}
