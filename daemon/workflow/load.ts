import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseAgentFile, type AgentFile } from '../prompt/buildPrompt.js';
import { parseWorkflow, type Workflow, WorkflowError } from './schema.js';

const AGENT_NAME = /^[a-z][a-z0-9-]*$/;

/** The project's `.factory/project.yml`. Unknown keys are errors, so typos do not pass silently. */
export const ProjectSettings = z.strictObject({
  /** The project's check command, e.g. `pnpm check`. Agents must have it green before they finish. */
  ci: z.string().min(1).optional(),
  /** Runner per role, e.g. `{ reviewer: codex }`. */
  runners: z.record(z.string().regex(AGENT_NAME), z.string().min(1)).default({}),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/** An agent file with its `extends` chain applied. */
export interface ResolvedAgent {
  /** The file name without `.md`, e.g. `frontend`. */
  name: string;
  /** The root of the `extends` chain, e.g. `implementer`. Runners per role use it. */
  role: string;
  /** The bodies of the chain, ancestors first. */
  body: string;
  /** Project files for the prompt, ancestors first. */
  context: string[];
  /** The nearest `runner` in the chain. */
  runner?: string;
  path: string;
  /** Why this agent was chosen, in Danish: `label area:frontend`, `projektagent` or `baseline`. */
  reason: string;
}

/**
 * Where agent files, rubrics, workflows and project settings come from: the project's `.factory/`
 * first, then the factory's `agents/baseline/`.
 *
 * An agent for a role is resolved in three steps: the project agent whose `scope.labels` match
 * most of the issue's labels, then the project's own file for the role, then the baseline file.
 */
export class AgentLibrary {
  constructor(
    /** `<factory>/agents/baseline` */
    readonly baselineDir: string,
    /** `<project>/.factory`, if the project has one. */
    readonly projectDir?: string,
  ) {}

  #candidates(relative: string): string[] {
    return [
      ...(this.projectDir ? [join(this.projectDir, relative)] : []),
      join(this.baselineDir, relative),
    ];
  }

  #find(relative: string): string | undefined {
    return this.#candidates(relative).find((path) => existsSync(path));
  }

  #agentCandidates(name: string): string[] {
    return [
      ...(this.projectDir ? [join(this.projectDir, 'agents', `${name}.md`)] : []),
      join(this.baselineDir, `${name}.md`),
    ];
  }

  agentPath(name: string): string | undefined {
    if (!AGENT_NAME.test(name)) return undefined;
    return this.#agentCandidates(name).find((path) => existsSync(path));
  }

  hasAgent(name: string): boolean {
    return this.agentPath(name) !== undefined;
  }

  /** Loads the named agent file (project first, then baseline) with its `extends` chain. */
  async loadAgent(name: string): Promise<ResolvedAgent> {
    const path = this.agentPath(name);
    if (!path) {
      throw new WorkflowError(
        `no agent file for "${name}" (looked in ${this.#agentCandidates(name).join(', ')})`,
      );
    }
    const resolved = await this.#resolve(path, []);
    return { ...resolved, reason: path.startsWith(this.baselineDir) ? 'baseline' : 'projektagent' };
  }

  /**
   * The agent for a role on an issue: the project agent for that role whose `scope.labels` match
   * most of the issue's labels (ties go to the first name alphabetically), else `loadAgent(role)`.
   */
  async resolveAgent(role: string, labels: readonly string[]): Promise<ResolvedAgent> {
    let best: { agent: ResolvedAgent; matched: string[] } | undefined;
    for (const { path, file } of await this.#projectAgents()) {
      const wanted = file.frontmatter.scope?.labels;
      if (!wanted) continue;
      const matched = wanted.filter((label) => labels.includes(label));
      if (matched.length === 0 || (best && matched.length <= best.matched.length)) continue;
      const agent = await this.#resolve(path, []);
      if (agent.role !== role) continue;
      best = { agent: { ...agent, reason: `label ${matched.join(', ')}` }, matched };
    }
    return best?.agent ?? this.loadAgent(role);
  }

  /** The paths of the agent files in the project's `.factory/agents/`, sorted by name. */
  async #projectAgentPaths(): Promise<string[]> {
    if (!this.projectDir) return [];
    const dir = join(this.projectDir, 'agents');
    if (!existsSync(dir)) return [];
    return (await readdir(dir))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((name) => join(dir, name));
  }

  async #projectAgents(): Promise<{ path: string; file: AgentFile }[]> {
    const paths = await this.#projectAgentPaths();
    return Promise.all(paths.map(async (path) => ({ path, file: await this.#read(path) })));
  }

  async #read(path: string): Promise<AgentFile> {
    try {
      return parseAgentFile(await readFile(path, 'utf8'));
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new WorkflowError(`${path} has invalid frontmatter:\n${z.prettifyError(error)}`);
      }
      throw new WorkflowError(
        `${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Applies the `extends` chain. A file extending its own name reaches the baseline file. */
  async #resolve(path: string, seen: string[]): Promise<Omit<ResolvedAgent, 'reason'>> {
    if (seen.includes(path)) {
      throw new WorkflowError(
        `agent files extend each other in a circle: ${[...seen, path].join(' → ')}`,
      );
    }
    const file = await this.#read(path);
    const name = basename(path, '.md');
    const own = {
      name,
      body: file.body,
      context: file.frontmatter.context ?? [],
      ...(file.frontmatter.runner && { runner: file.frontmatter.runner }),
      path,
    };
    const parentName = file.frontmatter.extends;
    if (!parentName) return { ...own, role: name };
    const parentPath = this.#agentCandidates(parentName).find(
      (candidate) => candidate !== path && existsSync(candidate),
    );
    if (!parentPath) throw new WorkflowError(`${path}: extends unknown agent "${parentName}"`);
    const parent = await this.#resolve(parentPath, [...seen, path]);
    return {
      ...own,
      role: parent.role,
      body: [parent.body, own.body].filter((b) => b !== '').join('\n\n'),
      context: [...new Set([...parent.context, ...own.context])],
      ...((own.runner ?? parent.runner) && { runner: own.runner ?? parent.runner }),
    };
  }

  /** Checks every project agent file and `.factory/project.yml`. Returns problems, one per line. */
  async checkProject(knownRunners: readonly string[]): Promise<string[]> {
    const problems: string[] = [];
    try {
      const settings = await this.projectSettings();
      for (const [role, runner] of Object.entries(settings.runners)) {
        if (!knownRunners.includes(runner)) {
          problems.push(
            `${join(this.projectDir ?? '', 'project.yml')}: runners.${role}: unknown runner "${runner}" (known: ${knownRunners.join(', ')})`,
          );
        }
      }
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    for (const path of await this.#projectAgentPaths()) {
      try {
        const agent = await this.#resolve(path, []);
        if (agent.runner && !knownRunners.includes(agent.runner)) {
          problems.push(
            `${path}: unknown runner "${agent.runner}" (known: ${knownRunners.join(', ')})`,
          );
        }
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    return problems;
  }

  /** The project's `.factory/project.yml`, or the defaults when there is none. */
  async projectSettings(): Promise<ProjectSettings> {
    const path = this.projectDir ? join(this.projectDir, 'project.yml') : undefined;
    if (!path || !existsSync(path)) return ProjectSettings.parse({});
    let raw: unknown;
    try {
      raw = parseYaml(await readFile(path, 'utf8')) ?? {};
    } catch (error) {
      throw new WorkflowError(
        `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = ProjectSettings.safeParse(raw);
    if (!parsed.success)
      throw new WorkflowError(`${path} is invalid:\n${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  rubricPath(rubric: string): string | undefined {
    if (rubric.includes('..')) return undefined;
    return this.#find(rubric);
  }

  async loadRubric(rubric: string): Promise<string> {
    const path = this.rubricPath(rubric);
    if (!path)
      throw new WorkflowError(
        `rubric ${rubric} not found (looked in ${this.#candidates(rubric).join(', ')})`,
      );
    return readFile(path, 'utf8');
  }

  /** Baseline workflows, overridden file by file by the project's `.factory/workflows/`. */
  async loadWorkflows(): Promise<Map<string, Workflow>> {
    const workflows = new Map<string, Workflow>();
    for (const dir of [
      join(this.baselineDir, 'workflows'),
      ...(this.projectDir ? [join(this.projectDir, 'workflows')] : []),
    ]) {
      if (!existsSync(dir)) continue;
      for (const file of (await readdir(dir)).filter((f) => f.endsWith('.yml')).sort()) {
        const path = join(dir, file);
        let raw: unknown;
        try {
          raw = parseYaml(await readFile(path, 'utf8'));
        } catch (error) {
          throw new WorkflowError(
            `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        workflows.set(basename(file, '.yml'), parseWorkflow(basename(file, '.yml'), path, raw));
      }
    }
    return workflows;
  }
}

/** Problems a schema cannot see: agents, rubrics and runners that do not exist. */
export function checkReferences(
  workflow: Workflow,
  library: AgentLibrary,
  knownRunners: readonly string[],
): string[] {
  const problems: string[] = [];
  const where = (stage: string) => `${workflow.source}: stage "${stage}"`;
  for (const stage of workflow.stages) {
    if (!library.hasAgent(stage.agent))
      problems.push(`${where(stage.id)}: unknown agent "${stage.agent}"`);
    if (stage.runner && !knownRunners.includes(stage.runner)) {
      problems.push(
        `${where(stage.id)}: unknown runner "${stage.runner}" (known: ${knownRunners.join(', ')})`,
      );
    }
    for (const gate of stage.gates) {
      if (gate.kind !== 'review') continue;
      if (!library.hasAgent(gate.agent))
        problems.push(`${where(stage.id)}: unknown review agent "${gate.agent}"`);
      if (!library.rubricPath(gate.rubric))
        problems.push(`${where(stage.id)}: rubric ${gate.rubric} not found`);
    }
    for (const step of stage.onFail) {
      if (step.kind === 'switch_agent' && !library.hasAgent(step.agent)) {
        problems.push(`${where(stage.id)}: switch_agent to unknown agent "${step.agent}"`);
      }
      // switch_runner to an unknown runner is allowed: the engine skips that step at run time.
    }
  }
  return problems;
}
