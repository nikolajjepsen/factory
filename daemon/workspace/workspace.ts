import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A git worktree that one task works in. Only the factory commits and pushes, never the agent. */
export interface Workspace {
  readonly path: string;
  readonly branch: string;
  /** The ref the branch was created from, for example `origin/main`. */
  readonly baseRef: string;
  /** Stages everything and commits. Returns the new sha, or undefined when nothing changed. */
  commitAll(message: string): Promise<string | undefined>;
  /** Commits on the branch since `baseRef`, oldest first. */
  commits(): Promise<string[]>;
  push(): Promise<void>;
  /** The sha of HEAD. */
  head(): Promise<string>;
  /** The branch's changes against `baseRef` as a unified diff. */
  diff(): Promise<string>;
}

/** Commits made by the factory are attributed to it, not to the person who owns the machine. */
export const FACTORY_GIT_IDENTITY = { name: 'ai-factory', email: 'factory@ai-factory.invalid' };

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export class GitWorkspace implements Workspace {
  constructor(
    readonly path: string,
    readonly branch: string,
    readonly baseRef: string,
  ) {}

  async commitAll(message: string): Promise<string | undefined> {
    await git(this.path, ['add', '--all']);
    if (await gitSucceeds(this.path, ['diff', '--cached', '--quiet'])) return undefined;
    const { name, email } = FACTORY_GIT_IDENTITY;
    await git(this.path, [
      '-c',
      `user.name=${name}`,
      '-c',
      `user.email=${email}`,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      message,
    ]);
    return git(this.path, ['rev-parse', 'HEAD']);
  }

  async commits(): Promise<string[]> {
    const out = await git(this.path, ['rev-list', '--reverse', `${this.baseRef}..HEAD`]);
    return out === '' ? [] : out.split('\n');
  }

  head(): Promise<string> {
    return git(this.path, ['rev-parse', 'HEAD']);
  }

  diff(): Promise<string> {
    return git(this.path, ['diff', `${this.baseRef}...HEAD`]);
  }

  async push(): Promise<void> {
    // Never --force: the factory only ever adds commits on top of its own branch.
    await git(this.path, ['push', '--quiet', '--set-upstream', 'origin', this.branch]);
  }
}

export interface PrepareOptions {
  project: string;
  issue: number;
  /** The project's own clone. Worktrees are added from it. */
  repoPath: string;
  branch: string;
  baseBranch?: string;
}

/** Creates or reuses one worktree per task under `<root>/<project>/<issue>`. */
export class WorktreeManager {
  constructor(private readonly root: string) {}

  pathFor(project: string, issue: number): string {
    return join(this.root, project, String(issue));
  }

  async prepare(options: PrepareOptions): Promise<GitWorkspace> {
    const { project, issue, repoPath, branch, baseBranch = 'main' } = options;
    const path = this.pathFor(project, issue);
    const hasOrigin = await gitSucceeds(repoPath, ['remote', 'get-url', 'origin']);
    if (hasOrigin) await git(repoPath, ['fetch', '--quiet', 'origin']);
    const baseRef = hasOrigin ? `origin/${baseBranch}` : baseBranch;

    if (existsSync(path)) {
      // Resume: an earlier run (for example an interrupted one) left WIP here.
      const current = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (current !== branch) {
        throw new Error(`worktree ${path} is on branch ${current}, expected ${branch}`);
      }
      return new GitWorkspace(path, branch, baseRef);
    }

    await mkdir(dirname(path), { recursive: true });
    const localBranch = await gitSucceeds(repoPath, [
      'rev-parse',
      '--verify',
      `refs/heads/${branch}`,
    ]);
    const remoteBranch =
      hasOrigin &&
      (await gitSucceeds(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]));
    if (localBranch) {
      await git(repoPath, ['worktree', 'add', '--quiet', path, branch]);
    } else if (remoteBranch) {
      await git(repoPath, [
        'worktree',
        'add',
        '--quiet',
        '--track',
        '-b',
        branch,
        path,
        `origin/${branch}`,
      ]);
    } else {
      await git(repoPath, [
        'worktree',
        'add',
        '--quiet',
        '--no-track',
        '-b',
        branch,
        path,
        baseRef,
      ]);
    }
    return new GitWorkspace(path, branch, baseRef);
  }
}

/** `factory/12-tilfoej-medlemsliste`: ASCII, lowercase, at most 40 characters of title. */
export function branchName(issue: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? `factory/${String(issue)}` : `factory/${String(issue)}-${slug}`;
}
