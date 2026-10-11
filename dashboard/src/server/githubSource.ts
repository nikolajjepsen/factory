import {
  type Command,
  type CommandResult,
  diffState,
  type FactoryState,
  parseStatusBody,
  STATUS_ISSUE_TITLE,
  toChatOps,
  withoutLog,
} from '@ai-factory/protocol';
import { z } from 'zod';
import { Listeners, type SourceEvent, type SourceStatus, type StateSource } from './source.js';

export interface GithubSourceOptions {
  token: string;
  /** `owner/name` of the repo with the "Factory Status" issue. */
  repo: string;
  pollMs: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

const Issues = z.array(
  z.looseObject({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable(),
    pull_request: z.unknown().optional(),
  }),
);

/**
 * `github` mode: reads the state from the pinned status issue every `pollMs` and sends commands as
 * `/factory` comments on it. It needs no access to the daemon, so it runs anywhere. The token must
 * belong to the factory's owner, since the daemon only executes the owner's comments.
 */
export class GithubSource implements StateSource {
  readonly #options: GithubSourceOptions & { fetch: typeof fetch; now: () => Date };
  readonly #listeners = new Listeners();
  #state: FactoryState | undefined;
  #status: SourceStatus = { mode: 'github', connected: false, error: null, updatedAt: null };
  #issue: number | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: GithubSourceOptions) {
    this.#options = {
      ...options,
      fetch: options.fetch ?? globalThis.fetch,
      now: options.now ?? (() => new Date()),
    };
  }

  status(): SourceStatus {
    return this.#status;
  }

  state(): FactoryState | undefined {
    return this.#state;
  }

  subscribe(listener: (event: SourceEvent) => void): () => void {
    return this.#listeners.add(listener);
  }

  start(): void {
    const tick = () => {
      void this.poll().finally(() => {
        this.#timer = setTimeout(tick, this.#options.pollMs);
      });
    };
    tick();
  }

  stop(): void {
    clearTimeout(this.#timer);
  }

  /** Reads the status issue once. */
  async poll(): Promise<void> {
    try {
      const issue = await this.#findIssue();
      const next = parseStatusBody(issue.body ?? '');
      if (!next) throw new Error('Statusissuet har ingen tilstand, eller dens format er ukendt.');
      const previous = this.#state;
      this.#state = next;
      this.#setStatus({
        connected: true,
        error: null,
        updatedAt: this.#options.now().toISOString(),
      });
      if (!previous) {
        this.#listeners.emit({ type: 'reset', state: next });
        return;
      }
      const event = diffState(withoutLog(previous), withoutLog(next));
      if (Object.keys(event).length > 0) this.#listeners.emit({ type: 'state', event });
      const lines = newLines(previous.log, next.log);
      if (lines.length > 0) this.#listeners.emit({ type: 'log', lines });
    } catch (error) {
      this.#setStatus({
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async command(command: Command): Promise<CommandResult> {
    const issue = this.#issue ?? (await this.#findIssue()).number;
    const line = toChatOps(command);
    const response = await this.#request(
      `/repos/${this.#options.repo}/issues/${String(issue)}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ body: line }),
      },
    );
    if (!response.ok) throw new Error(`GitHub svarede ${String(response.status)} på kommentaren.`);
    return {
      text: `Sendt som kommentar: ${line}. Daemonen udfører den inden for et minut.`,
      reply: false,
    };
  }

  async #findIssue() {
    const response = await this.#request(
      `/repos/${this.#options.repo}/issues?state=open&per_page=100`,
    );
    if (response.status === 401) throw new Error('GitHub afviste GITHUB_TOKEN (401).');
    if (!response.ok) throw new Error(`GitHub svarede ${String(response.status)}.`);
    const issue = Issues.parse(await response.json()).find(
      (i) => i.title === STATUS_ISSUE_TITLE && i.pull_request === undefined,
    );
    if (!issue) {
      throw new Error(`Der er intet åbent "${STATUS_ISSUE_TITLE}"-issue i ${this.#options.repo}.`);
    }
    this.#issue = issue.number;
    return issue;
  }

  #request(path: string, init: RequestInit = {}) {
    return this.#options.fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#options.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-factory-dashboard',
        ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
      },
    });
  }

  #setStatus(patch: Partial<SourceStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#listeners.emit({ type: 'status', status: this.#status });
  }
}

/** Log lines in `next` after the newest line `previous` already had. */
export function newLines(previous: readonly string[], next: readonly string[]): string[] {
  const last = previous.at(-1);
  if (last === undefined) return [...next];
  const at = next.lastIndexOf(last);
  return at < 0 ? [...next] : next.slice(at + 1);
}
