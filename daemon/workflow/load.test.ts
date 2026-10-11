import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryRoot } from '../config/projects.js';
import { AgentLibrary, checkReferences } from './load.js';

const baselineDir = join(factoryRoot, 'agents', 'baseline');

describe('baseline workflows', () => {
  it('are feature, bugfix, chore and idea, all valid with existing agents and rubrics', async () => {
    const library = new AgentLibrary(baselineDir);
    const workflows = await library.loadWorkflows();
    expect([...workflows.keys()].sort()).toEqual(['bugfix', 'chore', 'feature', 'idea']);
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

  it('finds the templates of the product department agents', async () => {
    const library = new AgentLibrary(baselineDir);
    for (const role of ['analyst', 'spec', 'planner']) {
      const agent = await library.loadAgent(role);
      expect(agent.templates.length).toBeGreaterThan(0);
      for (const name of agent.templates)
        await expect(library.loadTemplate(name)).resolves.toBeTruthy();
    }
    await expect(library.loadTemplate('../secrets')).rejects.toThrow(/not found/);
  });

  it('lets a project override a template', async () => {
    const library = await projectWith({ 'templates/spec.md': '# Projektets spec' });
    expect(await library.loadTemplate('spec')).toBe('# Projektets spec');
  });

  it('loads the baseline implementer shipped with the factory', async () => {
    const agent = await new AgentLibrary(baselineDir).loadAgent('implementer');
    expect(agent).toMatchObject({ name: 'implementer', role: 'implementer', reason: 'baseline' });
    expect(agent.body).toMatch(/^# Implementer/);
    expect(agent.body).toContain('Do not run `git commit`');
  });

  it('picks the domain agent whose labels match the issue, else the project agent, else baseline', async () => {
    const library = await projectWith({
      'agents/frontend.md':
        '---\nextends: implementer\nscope:\n  labels: [area:frontend]\ncontext: [docs/ui.md]\n---\n# Frontend',
      'agents/payments.md':
        '---\nextends: implementer\nscope:\n  labels: [area:payments, area:frontend]\nrunner: claude\n---\n# Betaling',
      'agents/ui-reviewer.md':
        '---\nextends: reviewer\nscope:\n  labels: [area:frontend]\n---\n# UI-review',
    });
    const frontend = await library.resolveAgent('implementer', ['area:frontend', 'bug']);
    expect(frontend).toMatchObject({
      name: 'frontend',
      role: 'implementer',
      reason: 'label area:frontend',
      context: ['docs/ui.md'],
    });
    expect(frontend.body).toMatch(/^# Implementer[\s\S]*\n\n# Frontend$/);

    // More matching labels win.
    expect(
      await library.resolveAgent('implementer', ['area:frontend', 'area:payments']),
    ).toMatchObject({
      name: 'payments',
      runner: 'claude',
      reason: 'label area:payments, area:frontend',
    });
    // A domain agent only stands in for its own role.
    expect(await library.resolveAgent('reviewer', ['area:frontend'])).toMatchObject({
      name: 'ui-reviewer',
    });
    expect(await library.resolveAgent('implementer', ['area:backend'])).toMatchObject({
      name: 'implementer',
      reason: 'baseline',
    });
  });

  it('breaks a tie between domain agents by name', async () => {
    const library = await projectWith({
      'agents/b-agent.md': '---\nextends: implementer\nscope:\n  labels: [area:x]\n---\nB',
      'agents/a-agent.md': '---\nextends: implementer\nscope:\n  labels: [area:x]\n---\nA',
    });
    expect((await library.resolveAgent('implementer', ['area:x'])).name).toBe('a-agent');
  });

  it('lets a project agent extend the baseline file of its own name', async () => {
    const library = await projectWith({
      'agents/implementer.md': '---\nextends: implementer\nrunner: codex\n---\nBrug pnpm.',
    });
    const agent = await library.resolveAgent('implementer', []);
    expect(agent).toMatchObject({ reason: 'projektagent', role: 'implementer', runner: 'codex' });
    expect(agent.body).toMatch(/^# Implementer[\s\S]*Brug pnpm\.$/);
  });

  it('reports circles, unknown parents, bad frontmatter and unknown runners with the file name', async () => {
    const library = await projectWith({
      'agents/a.md': '---\nextends: b\n---\n',
      'agents/b.md': '---\nextends: a\n---\n',
      'agents/c.md': '---\nextends: ghost\n---\n',
      'agents/d.md': '---\nscope:\n  paths: [src/]\n---\n',
      'agents/e.md': '---\nrunner: gpt\n---\n',
      'project.yml': 'runners:\n  reviewer: claude\n',
    });
    await expect(library.loadAgent('a')).rejects.toThrow(/extend each other in a circle/);
    await expect(library.loadAgent('c')).rejects.toThrow(/extends unknown agent "ghost"/);
    const problems = await library.checkProject(['codex']);
    expect(problems).toHaveLength(6);
    expect(problems[0]).toMatch(/project\.yml: runners\.reviewer: unknown runner "claude"/);
    expect(problems[4]).toMatch(/d\.md has invalid frontmatter/);
    expect(problems[5]).toMatch(/e\.md: unknown runner "gpt"/);
  });

  it('reads .factory/project.yml and rejects keys it does not know', async () => {
    expect(await new AgentLibrary(baselineDir).projectSettings()).toEqual({ runners: {} });
    const library = await projectWith({
      'project.yml': 'ci: pnpm check\nrunners:\n  reviewer: codex\n',
    });
    expect(await library.projectSettings()).toEqual({
      ci: 'pnpm check',
      runners: { reviewer: 'codex' },
    });
    const old = await projectWith({ 'project.yml': 'max_fix_iterations: 3\n' });
    await expect(old.projectSettings()).rejects.toThrow(/max_fix_iterations/);
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
