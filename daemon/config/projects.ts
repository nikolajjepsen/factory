import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// A project is a repo and a local checkout. Focus and on/off are daemon settings, not config.

const ProjectConfig = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must look like owner/name'),
  path: z.string().min(1),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

const ProjectsFile = z.object({ projects: z.record(z.string(), ProjectConfig) });

// Checked by hand: zod reports a bad record key only as "Invalid key in record".
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface Project extends ProjectConfig {
  name: string;
}

/** The factory's own repository root (where `agents/` and `projects.yml` live). */
export const factoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Runtime state: worktrees, the state database, the API token. */
export function factoryHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AI_FACTORY_HOME ?? join(homedir(), '.ai-factory');
}

export function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

export async function loadProjects(file: string): Promise<Map<string, Project>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${file} findes ikke. Opret den med dine projekter (se README).`, {
        cause: error,
      });
    }
    throw error;
  }
  const parsed = ProjectsFile.safeParse(parseYaml(text));
  if (!parsed.success) throw new Error(`${file} er ugyldig:\n${z.prettifyError(parsed.error)}`);
  const projects = new Map<string, Project>();
  for (const [name, config] of Object.entries(parsed.data.projects)) {
    if (!PROJECT_NAME.test(name)) {
      throw new Error(
        `${file} er ugyldig: projektnavnet "${name}" skal være kebab-case, fx loge-app.`,
      );
    }
    const expanded = expandHome(config.path);
    const path = isAbsolute(expanded) ? expanded : resolve(dirname(file), expanded);
    projects.set(name, { name, repo: config.repo, path });
  }
  return projects;
}

export async function loadProject(file: string, name: string): Promise<Project> {
  const projects = await loadProjects(file);
  const project = projects.get(name);
  if (!project) {
    const known = [...projects.keys()].join(', ') || '(ingen)';
    throw new Error(`Ukendt projekt "${name}". Kendte projekter i ${file}: ${known}`);
  }
  return project;
}
