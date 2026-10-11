import { z } from 'zod';
import type { FactoryConfig } from '../config/factoryConfig.js';
import { percentLeft, type QuotaSnapshot } from './quota.js';

// The quota policy (M4): pure functions from a snapshot and the rules in factory.yml to "go on" or
// "wait until". The daemon owns the I/O; everything here is testable with a fixed clock.

export type QuotaRules = FactoryConfig['quota'];

/** A weekly reset time that moves more than this means a new week began. */
const RESET_JITTER_MS = 60 * 60_000;

/**
 * Today's share of the weekly quota. It is fixed when the day starts, so spending during the day
 * does not shrink it, and persisted, so a restart keeps it.
 */
export const PacingDay = z.object({
  /** The local date, YYYY-MM-DD. */
  day: z.string(),
  /** Weekly `usedPercent` when the day started. */
  weeklyUsedAtStart: z.number(),
  weeklyResetsAt: z.iso.datetime().nullable(),
  /** Percentage points of the weekly quota the factory may use today. */
  budget: z.number(),
});
export type PacingDay = z.infer<typeof PacingDay>;

export interface QuotaBlock {
  /** Why the factory waits, in Danish. */
  reason: string;
  /** When work may resume, or null when the source does not say. */
  nextStart: string | null;
}

export interface QuotaStatus {
  snapshot: QuotaSnapshot;
  /** Unset when pacing is off or the weekly reset time is unknown. */
  pacing?: { day: string; budget: number; usedToday: number };
  /** Unset when work may go on. */
  block?: QuotaBlock;
}

export interface EvaluateInput {
  snapshot: QuotaSnapshot;
  rules: QuotaRules;
  /** The persisted pacing day, if any. */
  day: PacingDay | undefined;
  now: Date;
  timeZone?: string | undefined;
  /**
   * The owner set the rules aside (`/factory boost`): only a window Codex reports as used up
   * blocks. Pacing is still tracked, so tomorrow's budget reflects what was spent.
   */
  override?: boolean;
}

/** Applies the rules. Returns the status and the pacing day to persist. */
export function evaluateQuota(input: EvaluateInput): { status: QuotaStatus; day?: PacingDay } {
  const { snapshot, rules, now, timeZone } = input;
  const blocks: QuotaBlock[] = [];

  const fiveHourLeft = percentLeft(snapshot.fiveHour);
  if (fiveHourLeft < rules.pause_below_5h) {
    blocks.push({
      reason: `5-timersvinduet har ${percent(fiveHourLeft)} tilbage (grænsen er ${percent(rules.pause_below_5h)}).`,
      nextStart: snapshot.fiveHour.resetsAt,
    });
  }

  const weeklyLeft = percentLeft(snapshot.weekly);
  if (weeklyLeft <= rules.reserve_for_me) {
    blocks.push({
      reason:
        rules.reserve_for_me > 0
          ? `Ugekvoten er nede på reserven til dig (${percent(rules.reserve_for_me)}).`
          : 'Ugekvoten er brugt op.',
      nextStart: snapshot.weekly.resetsAt,
    });
  }

  const day = rules.pacing === 'even' ? pacingDay(input) : undefined;
  const status: QuotaStatus = { snapshot };
  if (day) {
    const usedToday = Math.max(0, snapshot.weekly.usedPercent - day.weeklyUsedAtStart);
    status.pacing = { day: day.day, budget: day.budget, usedToday };
    if (usedToday >= day.budget) {
      const midnight = nextLocalMidnight(now, timeZone).getTime();
      const weeklyReset = snapshot.weekly.resetsAt
        ? Date.parse(snapshot.weekly.resetsAt)
        : midnight;
      blocks.push({
        reason: `Dagens budget på ${percent(day.budget)} af ugekvoten er brugt.`,
        nextStart: new Date(Math.min(midnight, weeklyReset)).toISOString(),
      });
    }
  }

  const block = latest(input.override ? usedUp(snapshot) : blocks);
  if (block) status.block = block;
  return day ? { status, day } : { status };
}

/**
 * Keeps today's pacing day, or starts a new one on a new local date or a new week:
 * (weekly left − reserve) spread evenly over the time until the weekly reset, and today gets
 * the part of it before midnight. A day that starts at midnight gets left / days to reset; a day
 * that starts at 20:00 (first start, or a new week) gets only its last 4 hours' share.
 */
function pacingDay({ snapshot, rules, day, now, timeZone }: EvaluateInput): PacingDay | undefined {
  const resetsAt = snapshot.weekly.resetsAt;
  if (!resetsAt) return undefined;
  const today = localDate(now, timeZone);
  const used = snapshot.weekly.usedPercent;
  if (
    day?.day === today &&
    day.weeklyResetsAt !== null &&
    Math.abs(Date.parse(day.weeklyResetsAt) - Date.parse(resetsAt)) <= RESET_JITTER_MS &&
    used >= day.weeklyUsedAtStart
  ) {
    return day;
  }

  // Today gets the share of the time left that falls before midnight (or before the reset).
  const start = now.getTime();
  const reset = Date.parse(resetsAt);
  const endOfToday = Math.min(nextLocalMidnight(now, timeZone).getTime(), reset);
  const available = Math.max(0, 100 - used - rules.reserve_for_me);
  const budget = reset > start ? (available * (endOfToday - start)) / (reset - start) : available;
  return { day: today, weeklyUsedAtStart: used, weeklyResetsAt: resetsAt, budget };
}

/** Codex' own limit: a window with nothing left. */
function usedUp(snapshot: QuotaSnapshot): QuotaBlock[] {
  const windows = [
    { window: snapshot.fiveHour, name: '5-timersvinduet' },
    { window: snapshot.weekly, name: 'Ugekvoten' },
  ];
  return windows
    .filter(({ window }) => window.usedPercent >= 100)
    .map(({ window, name }) => ({
      reason: `${name} er brugt op hos Codex.`,
      nextStart: window.resetsAt,
    }));
}

/**
 * When Codex reports a usage limit the snapshot may not show yet: wait for the latest reset of a
 * full window, or else the 5-hour reset, the soonest moment the limit can have lifted.
 */
export function usageLimitResetTime(snapshot: QuotaSnapshot): string | null {
  const full = [snapshot.fiveHour, snapshot.weekly].filter((w) => w.usedPercent >= 100);
  const fullResets = full.map((w) => w.resetsAt).filter((r): r is string => r !== null);
  if (fullResets.length > 0)
    return fullResets.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
  return snapshot.fiveHour.resetsAt ?? snapshot.weekly.resetsAt;
}

/** The block that lasts longest. A block without a known end loses to one with an end. */
export function latest(blocks: readonly QuotaBlock[]): QuotaBlock | undefined {
  let chosen: QuotaBlock | undefined;
  for (const block of blocks) {
    if (!chosen) chosen = block;
    else if (block.nextStart && (!chosen.nextStart || block.nextStart > chosen.nextStart))
      chosen = block;
  }
  return chosen;
}

export function percent(value: number): string {
  return `${value.toLocaleString('da-DK', { maximumFractionDigits: 1 })} %`;
}

// Local calendar days in an IANA time zone (the system zone when unset), without a date library.

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone?: string): Parts {
  const format = new Intl.DateTimeFormat('en-US', {
    ...(timeZone && { timeZone }),
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const parts = Object.fromEntries(
    format.formatToParts(date).map((p) => [p.type, Number(p.value)]),
  );
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** How far the zone is ahead of UTC at this instant. */
function offsetMs(date: Date, timeZone?: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Midnight at the start of a local date. `day` may overflow; Date.UTC rolls it over. */
function localMidnight(year: number, month: number, day: number, timeZone?: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  // Two passes, so a daylight saving change between the guess and the answer is accounted for.
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

export function localDate(date: Date, timeZone?: string): string {
  const p = zonedParts(date, timeZone);
  return `${String(p.year)}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function nextLocalMidnight(date: Date, timeZone?: string): Date {
  const p = zonedParts(date, timeZone);
  return localMidnight(p.year, p.month, p.day + 1, timeZone);
}
