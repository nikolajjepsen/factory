import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseAgentFile, type AgentFile } from '../prompt/buildPrompt.js';
import { parseWorkflow, type Workflow, WorkflowError } from './schema.js';

/**
 * Where agent files, rubrics and workflows come from: the project's `.factory/` first, then the
 * factory's `agents/baseline/`. M6 adds scope matching on labels and paths.
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
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return undefined;
    return this.#agentCandidates(name).find((path) => existsSync(path));
  }

  hasAgent(name: string): boolean {
    return this.agentPath(name) !== undefined;
  }

  async loadAgent(name: string): Promise<AgentFile> {
    const path = this.agentPath(name);
    if (!path) {
      throw new WorkflowError(
        `no agent file for "${name}" (looked in ${this.#agentCandidates(name).join(', ')})`,
      );
    }
    return parseAgentFile(await readFile(path, 'utf8'));
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
