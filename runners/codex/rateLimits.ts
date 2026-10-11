import { z } from 'zod';
import type { QuotaSnapshot, QuotaWindow } from '../../daemon/quota/quota.js';

// Normalizes `account/rateLimits/read` and `account/rateLimits/updated` into a QuotaSnapshot.
// Codex 0.162 sends camelCase (see test/fixtures/codex/rate-limits-read.json). Older and
// internal payloads use snake_case, so every field is accepted in both spellings.

export const FIVE_HOUR_WINDOW_MINUTES = 300;
export const WEEKLY_WINDOW_MINUTES = 10_080;

const Timestamp = z.union([z.number(), z.string()]);

const RawWindow = z
  .object({
    usedPercent: z.number().optional(),
    used_percent: z.number().optional(),
    windowDurationMins: z.number().nullish(),
    window_minutes: z.number().nullish(),
    resetsAt: Timestamp.nullish(),
    resets_at: Timestamp.nullish(),
  })
  .transform((w) => ({
    usedPercent: w.usedPercent ?? w.used_percent,
    windowMinutes: w.windowDurationMins ?? w.window_minutes ?? undefined,
    resetsAt: w.resetsAt ?? w.resets_at ?? null,
  }));

const RawSnapshot = z.object({
  primary: RawWindow.nullish(),
  secondary: RawWindow.nullish(),
});
type RawSnapshot = z.infer<typeof RawSnapshot>;

const RawReadResponse = z
  .object({
    rateLimits: RawSnapshot.nullish(),
    rate_limits: RawSnapshot.nullish(),
    rateLimitsByLimitId: z.record(z.string(), RawSnapshot.nullish()).nullish(),
    rate_limits_by_limit_id: z.record(z.string(), RawSnapshot.nullish()).nullish(),
  })
  .transform((r) => ({
    byLimitId: r.rateLimitsByLimitId ?? r.rate_limits_by_limit_id ?? undefined,
    single: r.rateLimits ?? r.rate_limits ?? undefined,
  }));

const RawUpdatedNotification = z
  .object({
    rateLimits: RawSnapshot.nullish(),
    rate_limits: RawSnapshot.nullish(),
  })
  .transform((n) => n.rateLimits ?? n.rate_limits ?? undefined);

export class RateLimitsParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Unexpected Codex rate limits payload: ${message}`, options);
    this.name = 'RateLimitsParseError';
  }
}

/** The metered bucket that holds the plan's Codex quota. */
const CODEX_LIMIT_ID = 'codex';

/** Accepts unix seconds, unix milliseconds or an ISO 8601 string. */
export function toIsoTimestamp(value: number | string): string {
  let ms: number;
  if (typeof value === 'number') {
    // Unix seconds stay below 1e12 until the year 33658; milliseconds passed it in 2001.
    ms = value < 1e12 ? value * 1000 : value;
  } else if (/^\d+(\.\d+)?$/.test(value)) {
    return toIsoTimestamp(Number(value));
  } else {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms)) throw new RateLimitsParseError(`invalid timestamp ${String(value)}`);
  return new Date(ms).toISOString();
}

type ParsedWindows = Partial<Record<'fiveHour' | 'weekly', QuotaWindow>>;

/** Picks out the 5-hour and weekly windows by duration, whichever slot they arrive in. */
function windowsByDuration(snapshot: RawSnapshot): ParsedWindows {
  const result: ParsedWindows = {};
  for (const raw of [snapshot.primary, snapshot.secondary]) {
    if (!raw) continue;
    const key =
      raw.windowMinutes === FIVE_HOUR_WINDOW_MINUTES
        ? 'fiveHour'
        : raw.windowMinutes === WEEKLY_WINDOW_MINUTES
          ? 'weekly'
          : undefined;
    if (!key) continue;
    if (raw.usedPercent === undefined) {
      throw new RateLimitsParseError(`${key} window has no used percent`);
    }
    result[key] = {
      usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
      resetsAt: raw.resetsAt === null ? null : toIsoTimestamp(raw.resetsAt),
    };
  }
  return result;
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RateLimitsParseError(z.prettifyError(parsed.error), { cause: parsed.error });
  }
  return parsed.data;
}

export function normalizeRateLimitsResponse(raw: unknown, fetchedAt: Date): QuotaSnapshot {
  const response = parseOrThrow(RawReadResponse, raw);
  const snapshot = response.byLimitId?.[CODEX_LIMIT_ID] ?? response.single;
  if (!snapshot) throw new RateLimitsParseError('no rate limit snapshot in response');
  const { fiveHour, weekly } = windowsByDuration(snapshot);
  if (!fiveHour || !weekly) {
    const missing = [!fiveHour && '5-hour (300 min)', !weekly && 'weekly (10080 min)'];
    throw new RateLimitsParseError(`missing ${missing.filter(Boolean).join(' and ')} window`);
  }
  return { fiveHour, weekly, fetchedAt: fetchedAt.toISOString() };
}

function mergeWindow(previous: QuotaWindow, update: QuotaWindow | undefined): QuotaWindow {
  if (!update) return previous;
  return { usedPercent: update.usedPercent, resetsAt: update.resetsAt ?? previous.resetsAt };
}

/**
 * Merges a sparse `account/rateLimits/updated` notification into the last snapshot. Windows and
 * reset times the update leaves out keep their previous values.
 */
export function applyRateLimitsUpdate(
  current: QuotaSnapshot,
  rawNotification: unknown,
  fetchedAt: Date,
): QuotaSnapshot {
  const snapshot = parseOrThrow(RawUpdatedNotification, rawNotification);
  const update = snapshot ? windowsByDuration(snapshot) : {};
  return {
    fiveHour: mergeWindow(current.fiveHour, update.fiveHour),
    weekly: mergeWindow(current.weekly, update.weekly),
    fetchedAt: fetchedAt.toISOString(),
  };
}
