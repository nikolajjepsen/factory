import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryRoot } from '../config/projects.js';
import { AgentLibrary, checkReferences } from './load.js';

const baselineDir = join(factoryRoot, 'agents', 'baseline');

describe('baseline workflows', () => {
  it('are feature, bugfix and chore, all valid with existing agents and rubrics', async () => {
    const library = new AgentLibrary(baselineDir);
    const workflows = await library.loadWorkflows();
    expect([...workflows.keys()].sort()).toEqual(['bugfix', 'chore', 'feature']);
    for (const workflow of workflows.values()) {
      expect(checkReferences(workflow, library, ['codex'])).toEqual([]);
    }
  });
});

describe('AgentLibrary', () => {
  async function projectWith(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'ai-factory-lib-'));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, '..'), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return new AgentLibrary(baselineDir, dir);
  }

  it('lets the project override a baseline workflow by file id and add its own', async () => {
    const library = await projectWith({
      'workflows/feature.yml': 'stages:\n  - id: custom\n    agent: implementer\n',
      'workflows/docs.yml': 'stages:\n  - id: write\n    agent: implementer\n',
    });
    const workflows = await library.loadWorkflows();
    expect(workflows.get('feature')?.stages.map((s) => s.id)).toEqual(['custom']);
    expect(workflows.get('docs')?.source).toMatch(/workflows\/docs\.yml$/);
    expect(workflows.get('chore')?.source).toContain(baselineDir);
  });

  it('prefers project agents and rubrics over the baseline', async () => {
    const library = await projectWith({
      'agents/implementer.md': '---\nrole: implementer\n---\n# Projektets implementer',
      'rubrics/code.md': '# Projektets rubrik',
    });
    expect((await library.loadAgent('implementer')).body).toBe('# Projektets implementer');
    expect((await library.loadAgent('reviewer')).body).toMatch(/^# Reviewer/);
    expect(await library.loadRubric('rubrics/code.md')).toBe('# Projektets rubrik');
  });

  it('refuses names and paths that try to leave the library', async () => {
    const library = new AgentLibrary(baselineDir);
    expect(library.hasAgent('../secrets')).toBe(false);
    expect(library.rubricPath('../../etc/passwd.md')).toBeUndefined();
    await expect(library.loadAgent('nobody')).rejects.toThrow(/no agent file for "nobody"/);
  });

  it('reports invalid YAML with the file name', async () => {
    const library = await projectWith({ 'workflows/broken.yml': 'stages: [' });
    await expect(library.loadWorkflows()).rejects.toThrow(/broken\.yml is not valid YAML/);
  });
});

describe('checkReferences', () => {
  it('finds unknown agents, rubrics and runners', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ai-factory-lib-'));
    await mkdir(join(dir, 'workflows'));
    await writeFile(
      join(dir, 'workflows', 'x.yml'),
      `stages:
  - id: a
    agent: ghost
    runner: claude
    gates: [{ review: { agent: critic, rubric: rubrics/none.md, min_score: 5 } }]
    on_fail: [switch_agent: phantom, switch_runner: other, escalate: human]
`,
    );
    const library = new AgentLibrary(baselineDir, dir);
    const workflow = (await library.loadWorkflows()).get('x');
    if (!workflow) throw new Error('missing');
    expect(
      checkReferences(workflow, library, ['codex']).map((p) => p.replace(/^.*: stage "a": /, '')),
    ).toEqual([
      'unknown agent "ghost"',
      'unknown runner "claude" (known: codex)',
      'unknown review agent "critic"',
      'rubric rubrics/none.md not found',
      'switch_agent to unknown agent "phantom"',
    ]);
  });
});
