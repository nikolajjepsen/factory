import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to direct mode against host.orb.internal on port 80, token from a file', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'dash-')), 'token');
    await writeFile(file, 'secret\n');
    expect(loadConfig({ FACTORY_API_TOKEN_FILE: file })).toEqual({
      mode: 'direct',
      apiUrl: 'http://host.orb.internal:4712',
      token: 'secret',
      common: { name: null, host: '0.0.0.0', port: 80 },
    });
  });

  it('needs a token in direct mode, and a GitHub token and repo in github mode', () => {
    expect(() => loadConfig({})).toThrow('FACTORY_MODE=direct kræver FACTORY_API_TOKEN');
    expect(() => loadConfig({ FACTORY_MODE: 'github', GITHUB_TOKEN: 'g' })).toThrow(
      'FACTORY_STATUS_REPO',
    );
    expect(
      loadConfig({
        FACTORY_MODE: 'github',
        GITHUB_TOKEN: 'g',
        FACTORY_STATUS_REPO: 'o/factory',
        DASHBOARD_NAME: 'Nikolaj',
      }),
    ).toMatchObject({
      mode: 'github',
      statusRepo: 'o/factory',
      pollMs: 30_000,
      common: { name: 'Nikolaj' },
    });
  });
});
