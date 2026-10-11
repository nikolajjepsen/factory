import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

export const Issue = z.object({
  number: z.number(),
  title: z.string(),
  body: z
    .string()
    .nullable()
    .transform((body) => body ?? ''),
  html_url: z.string(),
  state: z.string(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() })])),
  /** GitHub issue types exist only on organization repos. */
  type: z.object({ name: z.string() }).nullish(),
});
export type Issue = z.infer<typeof Issue>;

export function labelNames(issue: Pick<Issue, 'labels'>): string[] {
  return issue.labels
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((name): name is string => name !== undefined);
}

export const PullRequest = z.object({
  number: z.number(),
  html_url: z.string(),
  state: z.string(),
});
export type PullRequest = z.infer<typeof PullRequest>;

export const CheckRun = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().nullable(),
  app: z.object({ slug: z.string() }).nullable(),
});
export type CheckRun = z.infer<typeof CheckRun>;

export const CommitStatus = z.object({
  context: z.string(),
  state: z.enum(['error', 'failure', 'pending', 'success']),
  description: z.string().nullable(),
  target_url: z.string().nullable(),
});
export type CommitStatus = z.infer<typeof CommitStatus>;

export const Review = z.object({
  user: z.object({ login: z.string() }).nullable(),
  state: z.string(),
  body: z.string().nullable(),
  submitted_at: z.string().nullable().optional(),
});
export type Review = z.infer<typeof Review>;

export interface CreatePullRequest {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** The GitHub operations the factory uses. Tests replace it with a fake. */
export interface GitHub {
  getIssue(repo: string, number: number): Promise<Issue>;
  findOpenPullRequest(repo: string, head: string): Promise<PullRequest | undefined>;
  createPullRequest(repo: string, pr: CreatePullRequest): Promise<PullRequest>;
  getDefaultBranch(repo: string): Promise<string>;
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  /** Removing a label the issue does not have is not an error. */
  removeLabel(repo: string, issue: number, label: string): Promise<void>;
  createComment(repo: string, issue: number, body: string): Promise<void>;
  listCheckRuns(repo: string, sha: string): Promise<CheckRun[]>;
  /** Legacy commit statuses (not check runs) for a sha. */
  listCommitStatuses(repo: string, sha: string): Promise<CommitStatus[]>;
  /** The plain-text log of a GitHub Actions job (its check run id). */
  getJobLog(repo: string, jobId: number): Promise<string>;
  listReviews(repo: string, pr: number): Promise<Review[]>;
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`invalid repo "${repo}", expected owner/name`);
  return { owner, repo: name };
}

/** Uses the token from `gh auth login`, so the factory needs no token of its own. */
export async function ghAuthToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token']);
    return stdout.trim();
  } catch (error) {
    throw new Error('Kunne ikke hente GitHub-token fra gh. Kør "gh auth login".', {
      cause: error,
    });
  }
}

export class OctokitGitHub implements GitHub {
  constructor(private readonly octokit: Octokit) {}

  static async fromGhCli(): Promise<OctokitGitHub> {
    return new OctokitGitHub(
      new Octokit({
        auth: await ghAuthToken(),
        userAgent: 'ai-factory',
        // Failed requests are thrown to the caller; Octokit's own error log only adds noise,
        // for example for the expected 404 when removing a label the issue does not have.
        log: {
          debug: () => undefined,
          info: () => undefined,
          warn: console.warn,
          error: () => undefined,
        },
      }),
    );
  }

  async getIssue(repo: string, number: number): Promise<Issue> {
    const { data } = await this.octokit.rest.issues.get({
      ...splitRepo(repo),
      issue_number: number,
    });
    return Issue.parse(data);
  }

  async findOpenPullRequest(repo: string, head: string): Promise<PullRequest | undefined> {
    const { owner } = splitRepo(repo);
    const { data } = await this.octokit.rest.pulls.list({
      ...splitRepo(repo),
      head: `${owner}:${head}`,
      state: 'open',
    });
    const first = data[0];
    return first ? PullRequest.parse(first) : undefined;
  }

  async createPullRequest(repo: string, pr: CreatePullRequest): Promise<PullRequest> {
    const { data } = await this.octokit.rest.pulls.create({ ...splitRepo(repo), ...pr });
    return PullRequest.parse(data);
  }

  async getDefaultBranch(repo: string): Promise<string> {
    const { data } = await this.octokit.rest.repos.get(splitRepo(repo));
    return z.object({ default_branch: z.string() }).parse(data).default_branch;
  }

  async addLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    await this.octokit.rest.issues.addLabels({ ...splitRepo(repo), issue_number: issue, labels });
  }

  async removeLabel(repo: string, issue: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        ...splitRepo(repo),
        issue_number: issue,
        name: label,
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }

  async createComment(repo: string, issue: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ ...splitRepo(repo), issue_number: issue, body });
  }

  async listCheckRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const { data } = await this.octokit.rest.checks.listForRef({
      ...splitRepo(repo),
      ref: sha,
      per_page: 100,
    });
    return z.array(CheckRun).parse(data.check_runs);
  }

  async listCommitStatuses(repo: string, sha: string): Promise<CommitStatus[]> {
    const { data } = await this.octokit.rest.repos.getCombinedStatusForRef({
      ...splitRepo(repo),
      ref: sha,
    });
    return z.array(CommitStatus).parse(data.statuses);
  }

  async getJobLog(repo: string, jobId: number): Promise<string> {
    const { data } = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
      ...splitRepo(repo),
      job_id: jobId,
    });
    // Octokit follows the redirect; the body arrives as text or as an ArrayBuffer.
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return String(data);
  }

  async listReviews(repo: string, pr: number): Promise<Review[]> {
    const { data } = await this.octokit.rest.pulls.listReviews({
      ...splitRepo(repo),
      pull_number: pr,
      per_page: 100,
    });
    return z.array(Review).parse(data);
  }
}
