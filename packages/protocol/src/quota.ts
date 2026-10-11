import { z } from 'zod';

export const QuotaWindow = z.object({
  /** Share of the window already used, 0–100. */
  usedPercent: z.number().min(0).max(100),
  /** ISO 8601 timestamp for the next reset, or null when the source does not say. */
  resetsAt: z.iso.datetime().nullable(),
});
export type QuotaWindow = z.infer<typeof QuotaWindow>;

export const QuotaSnapshot = z.object({
  fiveHour: QuotaWindow,
  weekly: QuotaWindow,
  /** ISO 8601 timestamp for when the source was read. */
  fetchedAt: z.iso.datetime(),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshot>;

/** Today's pacing budget, in percentage points of the weekly quota. */
export const PacingStatus = z.object({
  /** The local date, YYYY-MM-DD. */
  day: z.string(),
  budget: z.number(),
  usedToday: z.number(),
});
export type PacingStatus = z.infer<typeof PacingStatus>;
