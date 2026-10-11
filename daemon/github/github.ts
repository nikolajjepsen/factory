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
});
export type Issue = z.infer<typeof Issue>;

export const PullRequest = z.object({
  number: z.number(),
  html_url: z.string(),
  state: z.string(),
});
export type PullRequest = z.infer<typeof PullRequest>;

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
    return new OctokitGitHub(new Octokit({ auth: await ghAuthToken(), userAgent: 'ai-factory' }));
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
}
