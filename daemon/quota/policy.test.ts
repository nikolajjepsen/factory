import { describe, expect, it } from 'vitest';
import {
  evaluateQuota,
  localDate,
  nextLocalMidnight,
  type PacingDay,
  type QuotaRules,
  usageLimitResetTime,
} from './policy.js';
import type { QuotaSnapshot } from './quota.js';

const timeZone = 'Europe/Copenhagen';
const rules: QuotaRules = { pause_below_5h: 15, reserve_for_me: 0, pacing: 'even' };
// Monday 12 October 2026, 00:00 in Copenhagen (UTC+2).
const mondayMidnight = new Date('2026-10-11T22:00:00.000Z');
// Friday 16 October 00:00 in Copenhagen: exactly four days after Monday's midnight.
const weeklyReset = '2026-10-15T22:00:00.000Z';

function snapshot(
  fiveHourUsed: number,
  weeklyUsed: number,
  weeklyResetsAt: string | null = weeklyReset,
): QuotaSnapshot {
  return {
    fiveHour: { usedPercent: fiveHourUsed, resetsAt: '2026-10-12T11:00:00.000Z' },
    weekly: { usedPercent: weeklyUsed, resetsAt: weeklyResetsAt },
    fetchedAt: '2026-10-12T08:00:00.000Z',
  };
}

function evaluate(
  snap: QuotaSnapshot,
  options: { day?: PacingDay; now?: Date; rules?: Partial<QuotaRules> } = {},
) {
  return evaluateQuota({
    snapshot: snap,
    rules: { ...rules, ...options.rules },
    day: options.day,
    now: options.now ?? mondayMidnight,
    timeZone,
  });
}

describe('evaluateQuota: even pacing', () => {
  it('spreads what is left of the week evenly: 60 % over 4 days gives 15 % a day', () => {
    const { status, day } = evaluate(snapshot(10, 40));
    expect(day).toEqual({
      day: '2026-10-12',
      weeklyUsedAtStart: 40,
      weeklyResetsAt: weeklyReset,
      budget: 15,
    });
    expect(status.pacing).toEqual({ day: '2026-10-12', budget: 15, usedToday: 0 });
    expect(status.block).toBeUndefined();
  });

  it('keeps the budget fixed during the day and waits for tomorrow when it is used', () => {
    const { day } = evaluate(snapshot(10, 40));
    const later = new Date('2026-10-12T15:00:00.000Z');
    const within = evaluate(snapshot(20, 54), { day, now: later });
    expect(within.day).toBe(day);
    expect(within.status.pacing).toMatchObject({ budget: 15, usedToday: 14 });
    expect(within.status.block).toBeUndefined();

    const spent = evaluate(snapshot(20, 55), { day, now: later });
    expect(spent.status.block).toEqual({
      reason: 'Dagens budget på 15 % af ugekvoten er brugt.',
      // Tuesday 00:00 in Copenhagen.
      nextStart: '2026-10-12T22:00:00.000Z',
    });
  });

  it('gives a day that starts in the evening only the share of its last hours', () => {
    // Sunday 20:00: 4 of the 100 hours left until Friday 00:00 fall before midnight.
    const { day } = evaluate(snapshot(10, 40), { now: new Date('2026-10-11T18:00:00.000Z') });
    expect(day).toMatchObject({ day: '2026-10-11', budget: 2.4 });
  });

  it('starts a new budget the next day from what is left then', () => {
    const { day } = evaluate(snapshot(10, 40));
    const tuesday = new Date('2026-10-12T22:00:00.000Z');
    const next = evaluate(snapshot(0, 55), { day, now: tuesday });
    expect(next.day).toMatchObject({ day: '2026-10-13', weeklyUsedAtStart: 55, budget: 15 });
    expect(next.status.block).toBeUndefined();
  });

  it('counts a last, partial day as a fraction of a day', () => {
    // The week resets Thursday at 06:00, 3.25 days after Monday's midnight: 65 / 3.25 = 20.
    const { day } = evaluate(snapshot(10, 35, '2026-10-15T04:00:00.000Z'));
    expect(day?.budget).toBe(20);
  });

  it('lets the factory use everything left when the week resets before tomorrow', () => {
    const { day } = evaluate(snapshot(10, 70, '2026-10-12T20:00:00.000Z'));
    expect(day?.budget).toBe(30);
  });

  it('waits only until the weekly reset when that comes before midnight', () => {
    const resetTonight = '2026-10-12T20:00:00.000Z';
    const { day } = evaluate(snapshot(10, 70, resetTonight));
    const spent = evaluate(snapshot(10, 100, resetTonight), { day });
    expect(spent.status.block?.nextStart).toBe(resetTonight);
  });

  it('starts over when a new week begins during the day', () => {
    const { day } = evaluate(snapshot(10, 90));
    const newWeek = evaluate(snapshot(10, 2, '2026-10-19T08:00:00.000Z'), { day });
    expect(newWeek.day).toMatchObject({ weeklyUsedAtStart: 2 });
    expect(newWeek.status.block).toBeUndefined();
  });

  it('holds back the reserve before spreading the rest', () => {
    const { day } = evaluate(snapshot(10, 40), { rules: { reserve_for_me: 10 } });
    expect(day?.budget).toBe(12.5);
  });

  it('can be turned off, and is off when the weekly reset time is unknown', () => {
    expect(evaluate(snapshot(10, 40), { rules: { pacing: 'none' } })).toEqual({
      status: { snapshot: snapshot(10, 40) },
    });
    expect(evaluate(snapshot(10, 40, null)).day).toBeUndefined();
  });
});

describe('evaluateQuota: hard limits', () => {
  it('waits for the 5-hour reset below pause_below_5h', () => {
    const { status } = evaluate(snapshot(86, 40));
    expect(status.block).toEqual({
      reason: '5-timersvinduet har 14 % tilbage (grænsen er 15 %).',
      nextStart: '2026-10-12T11:00:00.000Z',
    });
    expect(evaluate(snapshot(85, 40)).status.block).toBeUndefined();
  });

  it('waits for the weekly reset when only the reserve is left', () => {
    const { status } = evaluate(snapshot(10, 90), {
      rules: { reserve_for_me: 10, pacing: 'none' },
    });
    expect(status.block).toEqual({
      reason: 'Ugekvoten er nede på reserven til dig (10 %).',
      nextStart: weeklyReset,
    });
  });

  it('waits for the latest of several limits', () => {
    const { day } = evaluate(snapshot(10, 40));
    const both = evaluate(snapshot(90, 56), { day });
    expect(both.status.block?.nextStart).toBe('2026-10-12T22:00:00.000Z');
  });
});

describe('evaluateQuota: override (/factory boost)', () => {
  it('ignores pacing, pause_below_5h and the reserve, but still tracks the day', () => {
    const { day } = evaluate(snapshot(10, 40));
    const boosted = evaluateQuota({
      snapshot: snapshot(95, 95),
      rules: { ...rules, reserve_for_me: 10 },
      day,
      now: mondayMidnight,
      timeZone,
      override: true,
    });
    expect(boosted.status.block).toBeUndefined();
    expect(boosted.status.pacing).toMatchObject({ budget: 15, usedToday: 55 });
  });

  it('still stops when Codex reports a window as used up', () => {
    const { status } = evaluateQuota({
      snapshot: snapshot(100, 60),
      rules,
      day: undefined,
      now: mondayMidnight,
      timeZone,
      override: true,
    });
    expect(status.block).toEqual({
      reason: '5-timersvinduet er brugt op hos Codex.',
      nextStart: '2026-10-12T11:00:00.000Z',
    });
  });
});

describe('usageLimitResetTime', () => {
  it('waits for the full window, or else the 5-hour reset', () => {
    expect(usageLimitResetTime(snapshot(100, 50))).toBe('2026-10-12T11:00:00.000Z');
    expect(usageLimitResetTime(snapshot(40, 100))).toBe(weeklyReset);
    expect(usageLimitResetTime(snapshot(40, 50))).toBe('2026-10-12T11:00:00.000Z');
  });
});

describe('local days', () => {
  it('finds midnight in the time zone, also across a daylight saving change', () => {
    expect(localDate(new Date('2026-10-11T22:30:00.000Z'), timeZone)).toBe('2026-10-12');
    // Summer time ends in Denmark on 25 October 2026: that day has 25 hours.
    const dstDay = new Date('2026-10-25T12:00:00.000Z');
    expect(nextLocalMidnight(dstDay, timeZone).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
});
