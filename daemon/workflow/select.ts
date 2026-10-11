import { type Issue, labelNames } from '../github/github.js';

export interface WorkflowChoice {
  workflow: string;
  /** Why this workflow was chosen, for the log. */
  reason: string;
}

/** Issue types and plain labels that map to a workflow, when no `workflow:` label is set. */
const BY_TYPE: Record<string, string> = { feature: 'feature', bug: 'bugfix', chore: 'chore' };

/** The label that sends an issue to the product department (M7). */
export const IDEA_LABEL = 'idea';

/**
 * Picks the workflow for an issue: `/factory workflow` override, then a `workflow:<name>` label,
 * then the `idea` label (workflow `idea`), then the issue type (or a `feature`/`bug`/`chore`
 * label on repos without issue types), then `feature`.
 */
export function selectWorkflow(
  issue: Pick<Issue, 'labels' | 'type'>,
  available: ReadonlySet<string>,
  override?: string,
): WorkflowChoice {
  const require = (workflow: string, reason: string): WorkflowChoice => {
    if (!available.has(workflow)) {
      throw new Error(
        `workflow "${workflow}" (${reason}) findes ikke. Kendte: ${[...available].join(', ')}`,
      );
    }
    return { workflow, reason };
  };
  if (override) return require(override, '/factory workflow');
  const labels = labelNames(issue);
  const explicit = labels.find((label) => label.startsWith('workflow:'));
  if (explicit) return require(explicit.slice('workflow:'.length), `label ${explicit}`);
  if (labels.includes(IDEA_LABEL)) return require('idea', `label ${IDEA_LABEL}`);
  const type = issue.type?.name.toLowerCase();
  if (type && BY_TYPE[type]) return require(BY_TYPE[type], `issue-type ${type}`);
  for (const label of labels) {
    const mapped = BY_TYPE[label.toLowerCase()];
    if (mapped) return require(mapped, `label ${label}`);
  }
  return require('feature', 'standard');
}
