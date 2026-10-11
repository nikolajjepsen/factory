import { serve } from '@hono/node-server';
import {
  Command,
  type CommandResult,
  EVENT,
  diffState,
  type FactoryState,
  withoutLog,
} from '@ai-factory/protocol';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

/** What the API needs from the daemon. */
export interface ApiDaemon {
  state(): FactoryState;
  execute(command: Command): Promise<CommandResult>;
  onChange(listener: () => void): () => void;
  onLog(listener: (line: string) => void): () => void;
}

export interface ApiOptions {
  daemon: ApiDaemon;
  token: string;
  /** Changes arriving within this window go out as one `state` event. */
  debounceMs?: number;
  /** A comment line keeps idle connections open through proxies. */
  keepAliveMs?: number;
}

/**
 * The daemon API (M5a). Every route needs the bearer token. Commands go through the daemon's single
 * handler, the same one ChatOps uses. The server binds only to 127.0.0.1 (see `listen`).
 */
export function createApi(options: ApiOptions): Hono {
  const { daemon, token, debounceMs = 50, keepAliveMs = 25_000 } = options;
  const app = new Hono();
  app.use('*', bearerAuth({ token }));

  app.get('/state', (c) => c.json(daemon.state()));

  app.post('/commands', async (c) => {
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
    return c.json(await daemon.execute(parsed.data));
  });

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const state = daemon.state();
      let sent = withoutLog(state);
      await stream.writeSSE({ event: EVENT.state, data: JSON.stringify(sent) });
      await stream.writeSSE({ event: EVENT.log, data: JSON.stringify({ lines: state.log }) });

      // Writes are chained, so events keep their order.
      let queue = Promise.resolve();
      const send = (event: string, data: unknown) => {
        queue = queue
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          .catch(() => undefined);
      };
      let timer: NodeJS.Timeout | undefined;
      const flush = () => {
        timer = undefined;
        const current = withoutLog(daemon.state());
        const changed = diffState(sent, current);
        sent = current;
        if (Object.keys(changed).length > 0) send(EVENT.state, changed);
      };
      const offChange = daemon.onChange(() => {
        timer ??= setTimeout(flush, debounceMs);
      });
      const offLog = daemon.onLog((line) => {
        send(EVENT.log, { lines: [line] });
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
      offChange();
      offLog();
      clearInterval(keepAlive);
      clearTimeout(timer);
    }),
  );
  return app;
}

/** Serves the API on 127.0.0.1 only. Resolves once listening; call `close` to stop. */
export function listen(
  app: Hono,
  port: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            // Open SSE connections would keep close() waiting forever.
            if ('closeAllConnections' in server) server.closeAllConnections();
          }),
      });
    });
    server.once('error', reject);
  });
}
