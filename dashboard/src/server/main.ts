import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { DirectSource } from './directSource.js';
import { GithubSource } from './githubSource.js';
import type { StateSource } from './source.js';

const config = loadConfig();
const source: StateSource =
  config.mode === 'direct'
    ? new DirectSource({ apiUrl: config.apiUrl, token: config.token })
    : new GithubSource({
        token: config.githubToken,
        repo: config.statusRepo,
        pollMs: config.pollMs,
      });
source.start();

// The bundle lives in dist/ next to public/.
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const app = createApp({ source, name: config.common.name, publicDir });
const server = serve(
  { fetch: app.fetch, hostname: config.common.host, port: config.common.port },
  (info) => {
    const where = config.mode === 'direct' ? config.apiUrl : `statusissuet i ${config.statusRepo}`;
    process.stdout.write(
      `Kontrolrummet lytter på port ${String(info.port)} (${config.mode}: ${where}).\n`,
    );
  },
);

const shutdown = () => {
  source.stop();
  server.close();
  if ('closeAllConnections' in server) server.closeAllConnections();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
