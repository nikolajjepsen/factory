import { Command, EVENT, withoutLog } from '@ai-factory/protocol';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { SourceEvent, StateSource } from './source.js';

export interface AppOptions {
  source: StateSource;
  /** The name in the greeting, or null. */
  name: string | null;
  /** The built browser files (index.html, app.js, style.css). Unset in tests. */
  publicDir?: string;
  keepAliveMs?: number;
}

/** The browser's events: the protocol's `state` and `log`, plus `source` with the data's origin. */
export const SOURCE_EVENT = 'source';

/**
 * The dashboard's server. The browser only talks to this; the daemon's token (direct) or the
 * GitHub token (github) never leaves the container.
 *
 * The dashboard has no login: it is only reachable on this Mac (OrbStack domain, or 127.0.0.1 with
 * the docker-desktop profile). Commands must be JSON from the same origin, so other websites
 * cannot send them from the browser.
 */
export function createApp(options: AppOptions): Hono {
  const { source, name, publicDir, keepAliveMs = 25_000 } = options;
  const app = new Hono();

  app.get('/healthz', (c) => c.text('ok'));

  app.get('/api/config', (c) => c.json({ name, mode: source.status().mode }));

  app.get('/api/state', (c) => c.json({ source: source.status(), state: source.state() ?? null }));

  app.post('/api/commands', async (c) => {
    if (!(c.req.header('content-type') ?? '').startsWith('application/json')) {
      return c.json({ error: 'Kommandoer skal sendes som JSON.' }, 415);
    }
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== c.req.header('host')) {
      return c.json({ error: 'Kommandoer skal komme fra kontrolrummet selv.' }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Brødteksten skal være JSON.' }, 400);
    }
    const parsed = Command.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Ugyldig kommando.', issues: z.treeifyError(parsed.error) }, 400);
    }
    try {
      return c.json(await source.command(parsed.data));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let queue = Promise.resolve();
      const send = (event: string, data: unknown) => {
        queue = queue
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          .catch(() => undefined);
      };
      const sendFull = () => {
        const state = source.state();
        if (!state) return;
        send(EVENT.state, withoutLog(state));
        send(EVENT.log, { lines: state.log, reset: true });
      };
      send(SOURCE_EVENT, source.status());
      sendFull();
      const off = source.subscribe((event: SourceEvent) => {
        switch (event.type) {
          case 'reset':
            sendFull();
            break;
          case 'state':
            send(EVENT.state, event.event);
            break;
          case 'log':
            send(EVENT.log, { lines: event.lines });
            break;
          case 'status':
            send(SOURCE_EVENT, event.status);
            break;
        }
      });
      const keepAlive = setInterval(() => {
        queue = queue
          .then(() => stream.write(': ping\n\n'))
          .then(
            () => undefined,
            () => undefined,
          );
      }, keepAliveMs);
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
      off();
      clearInterval(keepAlive);
    }),
  );

  if (publicDir) {
    app.use('/*', serveStatic({ root: publicDir }));
    app.get('*', serveStatic({ root: publicDir, path: 'index.html' }));
  }
  return app;
}
