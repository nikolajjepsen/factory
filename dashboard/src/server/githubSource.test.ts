import { statusBlock } from '@ai-factory/protocol';
import { describe, expect, it } from 'vitest';
import { sampleState } from '../test/sample.js';
import { GithubSource, newLines } from './githubSource.js';
import type { SourceEvent } from './source.js';

function fakeGitHub() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const github = {
    calls,
    body: `## Factory Status\n${statusBlock(sampleState())}`,
    issues: () => [
      { number: 3, title: 'Noget andet', body: '', pull_request: undefined },
      { number: 1, title: 'Factory Status', body: github.body },
    ],
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'POST') return Promise.resolve(new Response('{}', { status: 201 }));
      return Promise.resolve(Response.json(github.issues()));
    }) as typeof fetch,
  };
  return github;
}

describe('GithubSource', () => {
  it('reads the state from the status issue and emits what changed', async () => {
    const github = fakeGitHub();
    const source = new GithubSource({
      token: 'gh',
      repo: 'o/factory',
      pollMs: 30_000,
      fetch: github.fetch,
    });
    const events: SourceEvent[] = [];
    source.subscribe((e) => events.push(e));
    await source.poll();
    expect(events[1]).toMatchObject({ type: 'reset' });
    expect(source.status()).toMatchObject({ mode: 'github', connected: true });
    expect(github.calls[0]?.url).toBe(
      'https://api.github.com/repos/o/factory/issues?state=open&per_page=100',
    );
    expect(new Headers(github.calls[0]?.init?.headers).get('authorization')).toBe('Bearer gh');

    const state = sampleState();
    github.body = statusBlock({
      ...state,
      mode: 'paused',
      log: [...state.log, '22:00:00 Tilstand: paused'],
    });
    events.length = 0;
    await source.poll();
    expect(events.filter((e) => e.type !== 'status')).toEqual([
      { type: 'state', event: { mode: 'paused' } },
      { type: 'log', lines: ['22:00:00 Tilstand: paused'] },
    ]);
  });

  it('sends commands as /factory comments on the status issue', async () => {
    const github = fakeGitHub();
    const source = new GithubSource({
      token: 'gh',
      repo: 'o/factory',
      pollMs: 30_000,
      fetch: github.fetch,
    });
    const result = await source.command({
      command: 'retry',
      issue: 22,
      project: 'loge-app',
      runner: 'claude',
    });
    const post = github.calls.at(-1);
    expect(post?.url).toBe('https://api.github.com/repos/o/factory/issues/1/comments');
    expect(JSON.parse(post?.init?.body as string)).toEqual({
      body: '/factory retry loge-app#22 --runner claude',
    });
    expect(result.text).toContain('inden for et minut');
  });

  it('reports a missing status issue', async () => {
    const github = fakeGitHub();
    github.issues = () => [];
    const source = new GithubSource({
      token: 'gh',
      repo: 'o/factory',
      pollMs: 30_000,
      fetch: github.fetch,
    });
    await source.poll();
    expect(source.status()).toMatchObject({
      connected: false,
      error: 'Der er intet åbent "Factory Status"-issue i o/factory.',
    });
  });

  it('finds new log lines after the last known one', () => {
    expect(newLines(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(newLines([], ['a'])).toEqual(['a']);
    expect(newLines(['x'], ['a', 'b'])).toEqual(['a', 'b']);
  });
});
