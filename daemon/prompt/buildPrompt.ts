import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export interface IssueInput {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface PromptParts {
  /** The agent file's body (frontmatter removed). */
  agent: string;
  issue: IssueInput;
  spec?: { path: string; text: string };
  /** The project's AGENTS.md, if it has one. */
  agentsMd?: string;
  /** Feedback from earlier attempts (failed gates, review comments), oldest first. */
  feedback?: string[];
  /** What this step must do, when it differs from solving the whole issue (stages, phases). */
  instructions?: string[];
}

const AgentFrontmatter = z.looseObject({ role: z.string().optional() });

export interface AgentFile {
  frontmatter: z.infer<typeof AgentFrontmatter>;
  body: string;
}

/** Splits `---` YAML frontmatter from the markdown body. M6 adds extends/scope/context/runner. */
export function parseAgentFile(text: string): AgentFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text.trim() };
  const frontmatter = AgentFrontmatter.parse(parseYaml(match[1] ?? '') ?? {});
  return { frontmatter, body: (match[2] ?? '').trim() };
}

/** Resolves the agent file for a role. Until M6 that is always the baseline. */
export async function loadAgentFile(agentsDir: string, role: string): Promise<AgentFile> {
  if (!/^[a-z][a-z0-9-]*$/.test(role)) throw new Error(`invalid role name: ${role}`);
  const path = join(agentsDir, 'baseline', `${role}.md`);
  try {
    return parseAgentFile(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no agent file for role "${role}" (looked for ${path})`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** The first `specs/....md` path an issue mentions, if any. */
export function findSpecPath(issueBody: string): string | undefined {
  return /(?:^|[\s(`[])(specs\/[\w./-]+\.md)\b/.exec(issueBody)?.[1];
}

/** Reads a file relative to the worktree, or undefined if it does not exist. */
export async function readOptional(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  try {
    return await readFile(join(root, relativePath), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Assembles the role prompt: agent file, then the issue, spec, project rules and feedback. */
export function buildPrompt(parts: PromptParts): string {
  const sections = [
    parts.agent,
    `# Issue #${String(parts.issue.number)}: ${parts.issue.title}\n\n${parts.issue.url}\n\n${parts.issue.body.trim() || '(ingen beskrivelse)'}`,
  ];
  if (parts.spec) sections.push(`# Spec (${parts.spec.path})\n\n${parts.spec.text.trim()}`);
  if (parts.agentsMd) sections.push(`# Project rules (AGENTS.md)\n\n${parts.agentsMd.trim()}`);
  if (parts.instructions && parts.instructions.length > 0) {
    sections.push(
      `# Your task in this step\n\n${parts.instructions.map((i) => i.trim()).join('\n\n')}`,
    );
  }
  if (parts.feedback && parts.feedback.length > 0) {
    const items = parts.feedback.map((item, i) => `## Attempt ${String(i + 1)}\n\n${item.trim()}`);
    sections.push(`# Feedback from earlier attempts\n\n${items.join('\n\n')}`);
  }
  return sections.join('\n\n---\n\n');
}

const MAX_DIFF_CHARS = 60_000;

export interface ReviewPromptParts {
  /** The reviewer agent file's body. */
  agent: string;
  rubric: string;
  issue: IssueInput;
  spec?: { path: string; text: string };
  agentsMd?: string;
  subject: { kind: 'diff'; diff: string; summary?: string } | { kind: 'plan'; plan: string };
}

/** The prompt for a review gate: reviewer, rubric, issue context and the change itself. */
export function buildReviewPrompt(parts: ReviewPromptParts): string {
  const base = buildPrompt({
    agent: parts.agent,
    issue: parts.issue,
    ...(parts.spec && { spec: parts.spec }),
    ...(parts.agentsMd !== undefined && { agentsMd: parts.agentsMd }),
  });
  let subject: string;
  if (parts.subject.kind === 'plan') {
    subject = `# The plan under review (PLAN.md)\n\n${parts.subject.plan.trim()}`;
  } else {
    const { diff, summary } = parts.subject;
    const shown =
      diff.length > MAX_DIFF_CHARS
        ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff afkortet; læs resten af filerne direkte)`
        : diff;
    subject = [
      '# The change under review',
      ...(summary ? [`The author's summary: ${summary}`] : []),
      `\`\`\`diff\n${shown || '(ingen ændringer)'}\n\`\`\``,
    ].join('\n\n');
  }
  return [base, `# Rubric\n\n${parts.rubric.trim()}`, subject].join('\n\n---\n\n');
}
