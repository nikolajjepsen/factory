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

/** Where the factory reads its usage quota from. The core only knows this interface. */
export interface QuotaSource {
  read(): Promise<QuotaSnapshot>;
  /** Called with a fresh snapshot whenever the source pushes an update. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: QuotaSnapshot) => void): () => void;
  close(): Promise<void>;
}

export function percentLeft(window: QuotaWindow): number {
  return Math.min(100, Math.max(0, 100 - window.usedPercent));
}
