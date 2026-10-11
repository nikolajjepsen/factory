import type { QuotaSnapshot, QuotaWindow } from '@ai-factory/protocol';

// The snapshot schemas live in packages/protocol, so the dashboard shares them.
export { QuotaSnapshot, QuotaWindow } from '@ai-factory/protocol';

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
