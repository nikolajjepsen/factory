import {
  appendLog,
  type Command,
  type CommandResult,
  EVENT,
  type FactoryState,
  LogEvent,
  mergeState,
  StateEvent,
} from '@ai-factory/protocol';
import { useEffect, useState } from 'preact/hooks';
import type { SourceStatus } from './model.js';

export interface View {
  state: FactoryState | null;
  source: SourceStatus | null;
}

/** Follows the dashboard server's event stream. EventSource reconnects by itself. */
export function useFactory(): View {
  const [view, setView] = useState<View>({ state: null, source: null });
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('source', (e) => {
      const source = JSON.parse((e as MessageEvent<string>).data) as SourceStatus;
      setView((v) => ({ ...v, source }));
    });
    events.addEventListener(EVENT.state, (e) => {
      const event = StateEvent.parse(JSON.parse((e as MessageEvent<string>).data));
      setView((v) => ({
        ...v,
        // The first state event is full; the log follows in its own event.
        state: v.state ? mergeState(v.state, event) : ({ ...event, log: [] } as FactoryState),
      }));
    });
    events.addEventListener(EVENT.log, (e) => {
      const { lines, reset } = LogEvent.parse(JSON.parse((e as MessageEvent<string>).data));
      setView((v) =>
        v.state
          ? { ...v, state: reset ? { ...v.state, log: lines } : appendLog(v.state, lines) }
          : v,
      );
    });
    events.onerror = () => {
      setView((v) =>
        v.source
          ? {
              ...v,
              source: {
                ...v.source,
                connected: false,
                error: 'Kontrolrummet mistede forbindelsen.',
              },
            }
          : v,
      );
    };
    return () => {
      events.close();
    };
  }, []);
  return view;
}

/** Re-renders every second, for heartbeat ages and the clock. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return now;
}

export async function sendCommand(command: Command): Promise<CommandResult> {
  const response = await fetch('/api/commands', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = (await response.json()) as CommandResult | { error: string };
  if ('error' in body) throw new Error(body.error);
  return body;
}

export async function loadConfig(): Promise<{ name: string | null }> {
  const response = await fetch('/api/config');
  return (await response.json()) as { name: string | null };
}
