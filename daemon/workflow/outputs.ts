import { z } from 'zod';

// The answers of read-only stages (`output: comment` and `output: issues`). Runners enforce them
// as structured output, like AgentReport for write turns.

const Status = z
  .enum(['done', 'blocked'])
  .describe('done: the task is solved. blocked: it cannot be solved without a human.');

export const CommentOutput = z.object({
  status: Status,
  summary: z.string().describe('What the comment says, in Danish, one sentence.'),
  comment: z.string().describe('The full comment in GitHub Markdown, in Danish.'),
});
export type CommentOutput = z.infer<typeof CommentOutput>;

export const PlannedIssue = z.object({
  key: z.string().describe('A short id that is unique in this list, e.g. "storage".'),
  title: z.string().describe('The issue title, in Danish.'),
  body: z
    .string()
    .describe('The issue body in GitHub Markdown, in Danish, following the template.'),
  area: z
    .string()
    .describe('The area in kebab-case, e.g. "storage". The issue gets the label area:<area>.'),
  dependsOn: z
    .array(z.string())
    .describe('Keys of earlier issues in this list that must be closed before this one.'),
});
export type PlannedIssue = z.infer<typeof PlannedIssue>;

export const IssuesOutput = z.object({
  status: Status,
  summary: z.string().describe('The plan in Danish, 1-3 sentences.'),
  issues: z.array(PlannedIssue).describe('The sub-issues in the order they should be built.'),
});
export type IssuesOutput = z.infer<typeof IssuesOutput>;

/** Problems with a plan the engine cannot build, in Danish. Empty when the plan is usable. */
export function planProblems(plan: IssuesOutput): string[] {
  const problems: string[] = [];
  if (plan.issues.length === 0) problems.push('Planen har ingen issues.');
  const seen = new Set<string>();
  for (const issue of plan.issues) {
    if (seen.has(issue.key)) problems.push(`Nøglen "${issue.key}" bruges flere gange.`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(areaName(issue.area))) {
      problems.push(`Området "${issue.area}" for "${issue.key}" skal være kebab-case.`);
    }
    for (const dep of issue.dependsOn) {
      if (!seen.has(dep)) {
        problems.push(
          `"${issue.key}" afhænger af "${dep}", som ikke er et tidligere issue i listen.`,
        );
      }
    }
    seen.add(issue.key);
  }
  return problems;
}

/** `storage` or `area:storage` → `storage`. */
export function areaName(area: string): string {
  return area.trim().replace(/^area:/, '');
}
