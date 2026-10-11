import type { Workspace } from '../../daemon/workspace/workspace.js';

/** Records commits instead of running git. `dirty` decides whether commitAll creates one. */
export class FakeWorkspace implements Workspace {
  readonly commitMessages: string[] = [];
  readonly shas: string[] = [];
  pushed = 0;
  dirty = true;

  constructor(
    readonly path = '/tmp/ai-factory-fixture/m2/wt-1',
    readonly branch = 'factory/1-demo',
    readonly baseRef = 'origin/main',
  ) {}

  commitAll(message: string): Promise<string | undefined> {
    if (!this.dirty) return Promise.resolve(undefined);
    this.commitMessages.push(message);
    const sha = `sha${String(this.shas.length + 1)}`;
    this.shas.push(sha);
    this.dirty = false;
    return Promise.resolve(sha);
  }

  commits(): Promise<string[]> {
    return Promise.resolve([...this.shas]);
  }

  push(): Promise<void> {
    this.pushed++;
    return Promise.resolve();
  }
}
