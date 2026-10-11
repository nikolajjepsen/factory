import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_API_PORT } from '@ai-factory/protocol';
import { z } from 'zod';

const Repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must look like owner/name');

/** A share from 0 to 100, written as `15%` or `15`. */
const Percent = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d+(\.\d+)?\s*%$/, 'must look like 15%')
      .transform((s) => Number.parseFloat(s)),
  ])
  .pipe(z.number().min(0).max(100));

export const FactoryConfig = z.object({
  board: z.object({
    owner: z.string().min(1),
    number: z.number().int().positive(),
    status: z.object({
      ready: z.string().min(1),
      in_progress: z.string().min(1),
      review: z.string().min(1),
      done: z.string().min(1),
    }),
  }),
  owner_login: z.string().min(1),
  status_repo: Repo,
  default_runner: z.string().min(1).default('codex'),
  limits: z
    .object({ ci_timeout_minutes: z.number().positive().default(30) })
    .default({ ci_timeout_minutes: 30 }),
  quota: z
    .object({
      /** Pause when less than this share of the 5-hour window is left. */
      pause_below_5h: Percent.default(15),
      /** The share of the weekly quota the factory never touches. */
      reserve_for_me: Percent.default(0),
      /** `even`: spread the weekly quota evenly over the days until it resets. */
      pacing: z.enum(['even', 'none']).default('even'),
    })
    .prefault({}),
  api: z
    .object({
      /** The daemon API listens on 127.0.0.1 at this port. */
      port: z.number().int().min(1).max(65535).default(DEFAULT_API_PORT),
    })
    .prefault({}),
});
export type FactoryConfig = z.infer<typeof FactoryConfig>;

export async function loadFactoryConfig(file: string): Promise<FactoryConfig> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Kunne ikke læse ${file}.`, { cause: error });
  }
  const parsed = FactoryConfig.safeParse(parseYaml(text));
  if (!parsed.success) throw new Error(`${file} er ugyldig:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
