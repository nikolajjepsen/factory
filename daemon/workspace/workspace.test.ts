import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchName, git, WorktreeManager } from './workspace.js';

// These tests run real git against temporary directories. No network: `origin` is a local bare repo.

let dir: string;
let repo: string;
let origin: string;
let manager: WorktreeManager;

async function commitFile(cwd: string, name: string, content: string, message: string) {
  await writeFile(join(cwd, name), content);
  await git(cwd, ['add', name]);
  await git(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message]);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ai-factory-ws-'));
  origin = join(dir, 'origin.git');
  repo = join(dir, 'repo');
  await git(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  await git(dir, ['clone', '-q', origin, repo]);
  await commitFile(repo, 'README.md', '# demo\n', 'init');
  await git(repo, ['push', '-q', 'origin', 'main']);
  manager = new WorktreeManager(join(dir, 'worktrees'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const prepare = (branch = 'factory/1-demo') =>
  manager.prepare({ project: 'demo', issue: 1, repoPath: repo, branch, baseBranch: 'main' });

describe('WorktreeManager', () => {
  it('creates a worktree per task from origin/main on a new branch', async () => {
    const ws = await prepare();
    expect(ws.path).toBe(join(dir, 'worktrees', 'demo', '1'));
    expect(ws.baseRef).toBe('origin/main');
    expect(await git(ws.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('factory/1-demo');
    expect(await ws.commits()).toEqual([]);
  });

  it('bases new branches on the latest origin/main, not the stale local clone', async () => {
    const other = join(dir, 'other');
    await git(dir, ['clone', '-q', origin, other]);
    await commitFile(other, 'NEW.md', 'new\n', 'newer main');
    await git(other, ['push', '-q', 'origin', 'main']);
    const ws = await prepare();
    expect(await git(ws.path, ['log', '-1', '--format=%s'])).toBe('newer main');
  });

  it('reuses an existing worktree, so an interrupted run can continue', async () => {
    const first = await prepare();
    await writeFile(join(first.path, 'wip.txt'), 'wip\n');
    await first.commitAll('WIP: demo#1 (interrupted)');
    const second = await prepare();
    expect(second.path).toBe(first.path);
    expect(await second.commits()).toHaveLength(1);
  });

  it('refuses a worktree that is on a different branch', async () => {
    await prepare('factory/1-demo');
    await expect(prepare('factory/1-renamed')).rejects.toThrow(/expected factory\/1-renamed/);
  });

  it('continues from a branch that only exists on origin', async () => {
    const ws = await prepare();
    await writeFile(join(ws.path, 'a.txt'), 'a\n');
    await ws.commitAll('Add a');
    await ws.push();
    // Simulate another machine: drop the worktree and the local branch.
    await git(repo, ['worktree', 'remove', '--force', ws.path]);
    await git(repo, ['branch', '-D', 'factory/1-demo']);
    const again = await prepare();
    expect(await git(again.path, ['log', '-1', '--format=%s'])).toBe('Add a');
  });

  it('works for a repository without origin', async () => {
    const local = join(dir, 'local');
    await git(dir, ['init', '-q', '-b', 'main', local]);
    await commitFile(local, 'README.md', 'x\n', 'init');
    const ws = await manager.prepare({
      project: 'local',
      issue: 2,
      repoPath: local,
      branch: 'factory/2',
    });
    expect(ws.baseRef).toBe('main');
  });
});

describe('GitWorkspace', () => {
  it('commits everything as ai-factory and lists commits oldest first', async () => {
    const ws = await prepare();
    await writeFile(join(ws.path, 'one.txt'), '1\n');
    const first = await ws.commitAll('Add one');
    await writeFile(join(ws.path, 'two.txt'), '2\n');
    const second = await ws.commitAll('Add two');
    expect(await ws.commits()).toEqual([first, second]);
    expect(await git(ws.path, ['log', '-1', '--format=%an <%ae>|%s'])).toBe(
      'ai-factory <factory@ai-factory.invalid>|Add two',
    );
  });

  it('returns undefined and makes no commit when nothing changed', async () => {
    const ws = await prepare();
    expect(await ws.commitAll('nothing')).toBeUndefined();
    expect(await ws.commits()).toEqual([]);
  });

  it('includes deleted and new untracked files', async () => {
    const ws = await prepare();
    await rm(join(ws.path, 'README.md'));
    await writeFile(join(ws.path, 'new.txt'), 'n\n');
    await ws.commitAll('Replace readme');
    expect(await git(ws.path, ['show', '--name-status', '--format=', 'HEAD'])).toBe(
      'D\tREADME.md\nA\tnew.txt',
    );
  });

  it('pushes the branch to origin with upstream tracking', async () => {
    const ws = await prepare();
    await writeFile(join(ws.path, 'a.txt'), 'a\n');
    const sha = await ws.commitAll('Add a');
    await ws.push();
    expect(await git(origin, ['rev-parse', 'refs/heads/factory/1-demo'])).toBe(sha);
    expect(await git(ws.path, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe(
      'origin/factory/1-demo',
    );
  });
});

describe('branchName', () => {
  it('makes an ASCII slug from the issue title', () => {
    expect(branchName(12, 'Tilføj medlemsliste med profilbillede')).toBe(
      'factory/12-tilfoej-medlemsliste-med-profilbillede',
    );
    expect(branchName(3, 'Fix: Åbn café-menuen!')).toBe('factory/3-fix-aabn-cafe-menuen');
  });

  it('caps the slug at 40 characters without a trailing dash', () => {
    const name = branchName(1, 'a'.repeat(39) + ' bbbbbb');
    expect(name).toBe(`factory/1-${'a'.repeat(39)}`);
  });

  it('falls back to the number for titles with no usable characters', () => {
    expect(branchName(7, '!!!')).toBe('factory/7');
  });
});
