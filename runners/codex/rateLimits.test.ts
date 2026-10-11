import { describe, expect, it } from 'vitest';
import type { QuotaSnapshot } from '../../daemon/quota/quota.js';
import { rateLimitsResult } from '../../test/support/fixtures.js';
import {
  applyRateLimitsUpdate,
  normalizeRateLimitsResponse,
  RateLimitsParseError,
  toIsoTimestamp,
} from './rateLimits.js';

const fetchedAt = new Date('2026-10-11T16:21:33.000Z');
const window = (
  usedPercent: number,
  windowDurationMins: number,
  resetsAt: number | string | null,
) => ({
  usedPercent,
  windowDurationMins,
  resetsAt,
});

describe('normalizeRateLimitsResponse', () => {
  it('normalizes the recorded Codex 0.162 response', () => {
    expect(normalizeRateLimitsResponse(rateLimitsResult, fetchedAt)).toEqual({
      fiveHour: { usedPercent: 3, resetsAt: new Date(1791750624 * 1000).toISOString() },
      weekly: { usedPercent: 0, resetsAt: new Date(1792337424 * 1000).toISOString() },
      fetchedAt: '2026-10-11T16:21:33.000Z',
    });
  });

  it('identifies windows by duration, not by primary/secondary', () => {
    const swapped = {
      rateLimits: {
        primary: window(40, 10080, 1792337424),
        secondary: window(12, 300, 1791750624),
      },
    };
    const snapshot = normalizeRateLimitsResponse(swapped, fetchedAt);
    expect(snapshot.fiveHour.usedPercent).toBe(12);
    expect(snapshot.weekly.usedPercent).toBe(40);
  });

  it('accepts snake_case fields and unix seconds', () => {
    const snake = {
      rate_limits: {
        primary: { used_percent: 25.5, window_minutes: 300, resets_at: 1791750624 },
        secondary: { used_percent: 60, window_minutes: 10080, resets_at: 1792337424 },
      },
    };
    expect(normalizeRateLimitsResponse(snake, fetchedAt)).toEqual({
      fiveHour: { usedPercent: 25.5, resetsAt: '2026-10-11T20:30:24.000Z' },
      weekly: { usedPercent: 60, resetsAt: '2026-10-18T15:30:24.000Z' },
      fetchedAt: fetchedAt.toISOString(),
    });
  });

  it('prefers the codex bucket in rateLimitsByLimitId over the single-bucket view', () => {
    const response = {
      rateLimits: { primary: window(99, 300, null), secondary: window(99, 10080, null) },
      rateLimitsByLimitId: {
        other: { primary: window(50, 300, null), secondary: window(50, 10080, null) },
        codex: { primary: window(7, 300, null), secondary: window(8, 10080, null) },
      },
    };
    const snapshot = normalizeRateLimitsResponse(response, fetchedAt);
    expect([snapshot.fiveHour.usedPercent, snapshot.weekly.usedPercent]).toEqual([7, 8]);
  });

  it('falls back to the single-bucket view when there is no codex bucket', () => {
    const response = {
      rateLimits: { primary: window(5, 300, null), secondary: window(6, 10080, null) },
      rateLimitsByLimitId: null,
    };
    expect(normalizeRateLimitsResponse(response, fetchedAt).fiveHour).toEqual({
      usedPercent: 5,
      resetsAt: null,
    });
  });

  it('clamps used percent to 0–100', () => {
    const response = {
      rateLimits: { primary: window(130, 300, null), secondary: window(-2, 10080, null) },
    };
    const snapshot = normalizeRateLimitsResponse(response, fetchedAt);
    expect([snapshot.fiveHour.usedPercent, snapshot.weekly.usedPercent]).toEqual([100, 0]);
  });

  it('fails clearly when a window is missing', () => {
    const response = {
      rateLimits: { primary: window(5, 300, null), secondary: window(6, 1440, null) },
    };
    expect(() => normalizeRateLimitsResponse(response, fetchedAt)).toThrow(
      /missing weekly \(10080 min\) window/,
    );
  });

  it('fails clearly on a payload with the wrong shape', () => {
    expect(() => normalizeRateLimitsResponse({ rateLimits: { primary: 'x' } }, fetchedAt)).toThrow(
      RateLimitsParseError,
    );
    expect(() => normalizeRateLimitsResponse({}, fetchedAt)).toThrow(/no rate limit snapshot/);
  });
});

describe('toIsoTimestamp', () => {
  it('accepts seconds, milliseconds, numeric strings and ISO strings', () => {
    const iso = '2026-10-11T20:30:24.000Z';
    expect(toIsoTimestamp(1791750624)).toBe(iso);
    expect(toIsoTimestamp(1791750624000)).toBe(iso);
    expect(toIsoTimestamp('1791750624')).toBe(iso);
    expect(toIsoTimestamp('2026-10-11T22:30:24+02:00')).toBe(iso);
  });

  it('rejects text that is not a timestamp', () => {
    expect(() => toIsoTimestamp('soon')).toThrow(RateLimitsParseError);
  });
});

describe('applyRateLimitsUpdate', () => {
  const current: QuotaSnapshot = {
    fiveHour: { usedPercent: 3, resetsAt: '2026-10-11T20:30:24.000Z' },
    weekly: { usedPercent: 0, resetsAt: '2026-10-18T15:30:24.000Z' },
    fetchedAt: '2026-10-11T16:00:00.000Z',
  };
  const later = new Date('2026-10-11T17:00:00.000Z');

  it('replaces the windows the update contains and keeps the rest', () => {
    const update = { rateLimits: { primary: window(9, 300, 1791750624), secondary: null } };
    expect(applyRateLimitsUpdate(current, update, later)).toEqual({
      fiveHour: { usedPercent: 9, resetsAt: '2026-10-11T20:30:24.000Z' },
      weekly: current.weekly,
      fetchedAt: later.toISOString(),
    });
  });

  it('keeps the known reset time when the update has none', () => {
    const update = { rateLimits: { primary: null, secondary: window(4, 10080, null) } };
    expect(applyRateLimitsUpdate(current, update, later).weekly).toEqual({
      usedPercent: 4,
      resetsAt: current.weekly.resetsAt,
    });
  });

  it('ignores windows with an unknown duration', () => {
    const update = { rateLimits: { primary: window(80, 60, null) } };
    const result = applyRateLimitsUpdate(current, update, later);
    expect([result.fiveHour, result.weekly]).toEqual([current.fiveHour, current.weekly]);
  });
});
