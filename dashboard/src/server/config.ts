import { readFileSync } from 'node:fs';
import { z } from 'zod';

const Env = z.object({
  FACTORY_MODE: z.enum(['direct', 'github']).default('direct'),
  FACTORY_API_URL: z.url().default('http://host.orb.internal:4712'),
  FACTORY_API_TOKEN: z.string().optional(),
  /** A file holding the token, e.g. a compose secret mounted from ~/.ai-factory/api-token. */
  FACTORY_API_TOKEN_FILE: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
  /** The repo with the pinned "Factory Status" issue, `owner/name`. */
  FACTORY_STATUS_REPO: z.string().optional(),
  GITHUB_POLL_SECONDS: z.coerce.number().int().min(10).default(30),
  /** The name in the greeting, e.g. "God aften, Nikolaj". */
  DASHBOARD_NAME: z.string().optional(),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(0).max(65535).default(80),
});

export type DashboardConfig =
  | { mode: 'direct'; apiUrl: string; token: string; common: Common }
  | { mode: 'github'; githubToken: string; statusRepo: string; pollMs: number; common: Common };

interface Common {
  name: string | null;
  host: string;
  port: number;
}

/** Reads the dashboard's settings from the environment, with Danish errors. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`Ugyldig konfiguration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  const common: Common = { name: e.DASHBOARD_NAME ?? null, host: e.HOST, port: e.PORT };
  if (e.FACTORY_MODE === 'github') {
    if (!e.GITHUB_TOKEN) throw new Error('FACTORY_MODE=github kræver GITHUB_TOKEN.');
    if (!e.FACTORY_STATUS_REPO || !/^[\w.-]+\/[\w.-]+$/.test(e.FACTORY_STATUS_REPO)) {
      throw new Error('FACTORY_MODE=github kræver FACTORY_STATUS_REPO som owner/navn.');
    }
    return {
      mode: 'github',
      githubToken: e.GITHUB_TOKEN,
      statusRepo: e.FACTORY_STATUS_REPO,
      pollMs: e.GITHUB_POLL_SECONDS * 1000,
      common,
    };
  }
  const token =
    e.FACTORY_API_TOKEN ??
    (e.FACTORY_API_TOKEN_FILE ? readFileSync(e.FACTORY_API_TOKEN_FILE, 'utf8').trim() : '');
  if (!token) {
    throw new Error(
      'FACTORY_MODE=direct kræver FACTORY_API_TOKEN eller FACTORY_API_TOKEN_FILE (se `factory api-token`).',
    );
  }
  return { mode: 'direct', apiUrl: e.FACTORY_API_URL.replace(/\/$/, ''), token, common };
}
