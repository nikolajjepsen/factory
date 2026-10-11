import type { Command, CommandResult, FactoryState, StateEvent } from '@ai-factory/protocol';

/** Where the dashboard's data comes from, shown in the UI with its age. */
export interface SourceStatus {
  mode: 'direct' | 'github';
  connected: boolean;
  /** Why the source cannot deliver, in Danish. */
  error: string | null;
  /** When the source last delivered data. */
  updatedAt: string | null;
}

export type SourceEvent =
  /** A full state: on (re)connect, or the first read. */
  | { type: 'reset'; state: FactoryState }
  | { type: 'state'; event: StateEvent }
  | { type: 'log'; lines: string[] }
  | { type: 'status'; status: SourceStatus };

/** Both modes look the same to the dashboard's server and the browser. */
export interface StateSource {
  status(): SourceStatus;
  /** The latest full state, if any. */
  state(): FactoryState | undefined;
  subscribe(listener: (event: SourceEvent) => void): () => void;
  command(command: Command): Promise<CommandResult>;
  start(): void;
  stop(): void;
}

/** Shared listener bookkeeping for sources. */
export class Listeners {
  readonly #listeners = new Set<(event: SourceEvent) => void>();
  add(listener: (event: SourceEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(event: SourceEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
