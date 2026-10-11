import { describe, expect, it } from 'vitest';
import { FactoryConfig, loadFactoryConfig } from './factoryConfig.js';
import { factoryRoot } from './projects.js';
import { join } from 'node:path';

const base = {
  board: {
    owner: 'o',
    number: 1,
    status: { ready: 'Ready', in_progress: 'In progress', review: 'In review', done: 'Done' },
  },
  owner_login: 'o',
  status_repo: 'o/factory',
};

describe('FactoryConfig quota', () => {
  it('defaults to 15 % for the 5-hour window, no reserve and even pacing', () => {
    expect(FactoryConfig.parse(base).quota).toEqual({
      pause_below_5h: 15,
      reserve_for_me: 0,
      pacing: 'even',
    });
  });

  it('reads shares written as 15% or as numbers, and rejects the rest', () => {
    const quota = { pause_below_5h: '12.5%', reserve_for_me: 10, pacing: 'none' };
    expect(FactoryConfig.parse({ ...base, quota }).quota).toEqual({
      pause_below_5h: 12.5,
      reserve_for_me: 10,
      pacing: 'none',
    });
    for (const bad of ['15', '150%', -1]) {
      expect(FactoryConfig.safeParse({ ...base, quota: { pause_below_5h: bad } }).success).toBe(
        false,
      );
    }
  });

  it('accepts the checked-in factory.yml', async () => {
    const config = await loadFactoryConfig(join(factoryRoot, 'factory.yml'));
    expect(config.quota.pacing).toBe('even');
  });
});
