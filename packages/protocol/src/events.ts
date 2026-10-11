import { z } from 'zod';
import { FactoryState } from './state.js';

// `GET /events` is a server-sent event stream. On connect the daemon sends one `state` event with
// the whole state; after that, `state` events carry only the fields that changed, and `log`
// events carry new log lines. A client merges each `state` event into what it has.

export const StateEvent = FactoryState.omit({ log: true }).partial();
export type StateEvent = z.infer<typeof StateEvent>;

export const LogEvent = z.object({ lines: z.array(z.string()) });
export type LogEvent = z.infer<typeof LogEvent>;

export const EVENT = { state: 'state', log: 'log' } as const;
