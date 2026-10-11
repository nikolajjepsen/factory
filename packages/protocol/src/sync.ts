import type { StateEvent } from './events.js';
import { FactoryState } from './state.js';

export type StateWithoutLog = Omit<FactoryState, 'log'>;

/** The state as a `state` event carries it: the log goes out as `log` events. */
export function withoutLog(state: FactoryState): StateWithoutLog {
  const copy: Partial<FactoryState> = { ...state };
  delete copy.log;
  return copy as StateWithoutLog;
}

/** The top-level fields of `next` that differ from `previous`, compared as JSON. */
export function diffState(previous: StateWithoutLog, next: StateWithoutLog): StateEvent {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify((previous as Record<string, unknown>)[key])) {
      changed[key] = value;
    }
  }
  return changed;
}

/** Applies a `state` event to a full state. */
export function mergeState(state: FactoryState, event: StateEvent): FactoryState {
  return { ...state, ...event };
}

/** Appends `log` event lines, keeping the newest `max`. */
export function appendLog(state: FactoryState, lines: readonly string[], max = 50): FactoryState {
  return { ...state, log: [...state.log, ...lines].slice(-max) };
}

const STATUS_MARKER = 'factory-status:v1';
export const STATUS_ISSUE_TITLE = 'Factory Status';

/** The hidden block in the status issue body that carries the state as JSON. */
export function statusBlock(state: FactoryState): string {
  return `<!-- ${STATUS_MARKER}\n${JSON.stringify(state)}\n-->`;
}

/** Reads the state out of a status issue body. Undefined if it has none or its shape is unknown. */
export function parseStatusBody(body: string): FactoryState | undefined {
  const match = new RegExp(`<!-- ${STATUS_MARKER}\\n(.*)\\n-->`).exec(body);
  if (!match?.[1]) return undefined;
  try {
    const parsed = FactoryState.safeParse(JSON.parse(match[1]));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
