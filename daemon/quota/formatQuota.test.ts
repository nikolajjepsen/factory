import { describe, expect, it } from 'vitest';
import { formatQuota, formatResetTime } from './formatQuota.js';
import { percentLeft, type QuotaSnapshot } from './quota.js';

const timeZone = 'Europe/Copenhagen';
const now = new Date('2026-10-11T16:21:33.000Z'); // søndag kl. 18.21 i København

describe('formatResetTime', () => {
  it('says "i dag" for a reset later today, with time left', () => {
    expect(formatResetTime('2026-10-11T20:30:24.000Z', { now, timeZone })).toBe(
      'i dag kl. 22.30 (om 4 t 9 min)',
    );
  });

  it('says "i morgen" for a reset tomorrow', () => {
    expect(formatResetTime('2026-10-12T05:00:00.000Z', { now, timeZone })).toBe(
      'i morgen kl. 07.00 (om 12 t 38 min)',
    );
  });

  it('shows weekday and date for later resets', () => {
    expect(formatResetTime('2026-10-18T15:30:24.000Z', { now, timeZone })).toBe(
      'søn. 18. okt. kl. 17.30 (om 6 d 23 t)',
    );
  });

  it('uses the given time zone', () => {
    expect(formatResetTime('2026-10-11T20:30:24.000Z', { now, timeZone: 'UTC' })).toMatch(
      /^i dag kl\. 20\.30/,
    );
  });

  it('handles a reset in the past and an unknown reset', () => {
    expect(formatResetTime('2026-10-11T16:00:00.000Z', { now, timeZone })).toBe(
      'i dag kl. 18.00 (nu)',
    );
    expect(formatResetTime(null, { now, timeZone })).toBe('nulstillingstid ukendt');
  });
});

describe('formatQuota', () => {
  it('prints both windows with percent left and reset time', () => {
    const snapshot: QuotaSnapshot = {
      fiveHour: { usedPercent: 3, resetsAt: '2026-10-11T20:30:24.000Z' },
      weekly: { usedPercent: 0, resetsAt: '2026-10-18T15:30:24.000Z' },
      fetchedAt: now.toISOString(),
    };
    expect(formatQuota(snapshot, { now, timeZone }).split('\n')).toEqual([
      'Codex-kvote (hentet 11. okt. 2026 kl. 18.21)',
      '5 timer    97 % tilbage   nulstilles i dag kl. 22.30 (om 4 t 9 min)',
      'Uge       100 % tilbage   nulstilles søn. 18. okt. kl. 17.30 (om 6 d 23 t)',
    ]);
  });

  it('rounds percent left to whole numbers', () => {
    const snapshot: QuotaSnapshot = {
      fiveHour: { usedPercent: 12.6, resetsAt: null },
      weekly: { usedPercent: 99.9, resetsAt: null },
      fetchedAt: now.toISOString(),
    };
    expect(formatQuota(snapshot, { now, timeZone })).toContain('87 % tilbage');
    expect(formatQuota(snapshot, { now, timeZone })).toContain('  0 % tilbage');
  });
});

describe('percentLeft', () => {
  it('is 100 minus used, kept within 0–100', () => {
    expect(percentLeft({ usedPercent: 3, resetsAt: null })).toBe(97);
    expect(percentLeft({ usedPercent: 100, resetsAt: null })).toBe(0);
  });
});
