import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const Repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must look like owner/name');

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
