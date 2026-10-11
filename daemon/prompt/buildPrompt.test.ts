import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factoryRoot } from '../config/projects.js';
import {
  buildPrompt,
  findSpecPath,
  loadAgentFile,
  parseAgentFile,
  readOptional,
} from './buildPrompt.js';

const issue = {
  number: 12,
  title: 'Medlemsliste',
  body: 'Vis alle medlemmer.',
  url: 'https://github.com/o/r/issues/12',
};

describe('parseAgentFile', () => {
  it('splits YAML frontmatter from the body', () => {
    expect(parseAgentFile('---\nrole: implementer\n---\n\n# Hi\n')).toEqual({
      frontmatter: { role: 'implementer' },
      body: '# Hi',
    });
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseAgentFile('# Just text\n')).toEqual({ frontmatter: {}, body: '# Just text' });
  });
});

describe('loadAgentFile', () => {
  it('loads the baseline implementer shipped with the factory', async () => {
    const agent = await loadAgentFile(join(factoryRoot, 'agents'), 'implementer');
    expect(agent.frontmatter.role).toBe('implementer');
    expect(agent.body).toMatch(/^# Implementer/);
    expect(agent.body).toContain('Do not run `git commit`');
  });

  it('names the missing file for an unknown role, and rejects path tricks', async () => {
    await expect(loadAgentFile(join(factoryRoot, 'agents'), 'astronaut')).rejects.toThrow(
      /no agent file for role "astronaut"/,
    );
    await expect(loadAgentFile(join(factoryRoot, 'agents'), '../secrets')).rejects.toThrow(
      /invalid role/,
    );
  });
});

describe('findSpecPath', () => {
  it('finds the first specs/*.md path the issue mentions', () => {
    expect(findSpecPath('Se specs/galleri/upload.md for detaljer')).toBe('specs/galleri/upload.md');
    expect(findSpecPath('Spec: `specs/medlemmer.md`')).toBe('specs/medlemmer.md');
    expect(findSpecPath('(specs/a.md) og specs/b.md')).toBe('specs/a.md');
  });

  it('ignores lookalikes', () => {
    expect(findSpecPath('nospecs/a.md')).toBeUndefined();
    expect(findSpecPath('specs/a.txt')).toBeUndefined();
  });
});

describe('readOptional', () => {
  it('reads a file under the root, or returns undefined when it is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ai-factory-prompt-'));
    await mkdir(join(root, 'specs'));
    await writeFile(join(root, 'specs', 'a.md'), 'spec');
    expect(await readOptional(root, 'specs/a.md')).toBe('spec');
    expect(await readOptional(root, 'AGENTS.md')).toBeUndefined();
  });
});

describe('buildPrompt', () => {
  it('orders agent, issue, spec, project rules and feedback', () => {
    const prompt = buildPrompt({
      agent: '# Implementer',
      issue,
      spec: { path: 'specs/m.md', text: 'Spec-tekst' },
      agentsMd: 'Brug pnpm.',
      feedback: ['CI fejlede: lint', 'Review: mangler test'],
    });
    const sections = prompt.split('\n\n---\n\n');
    expect(sections).toEqual([
      '# Implementer',
      '# Issue #12: Medlemsliste\n\nhttps://github.com/o/r/issues/12\n\nVis alle medlemmer.',
      '# Spec (specs/m.md)\n\nSpec-tekst',
      '# Project rules (AGENTS.md)\n\nBrug pnpm.',
      '# Feedback from earlier attempts\n\n## Attempt 1\n\nCI fejlede: lint\n\n## Attempt 2\n\nReview: mangler test',
    ]);
  });

  it('leaves out what is missing and marks an empty issue body', () => {
    const prompt = buildPrompt({ agent: 'A', issue: { ...issue, body: '  ' }, feedback: [] });
    expect(prompt).toBe(
      'A\n\n---\n\n# Issue #12: Medlemsliste\n\nhttps://github.com/o/r/issues/12\n\n(ingen beskrivelse)',
    );
  });
});
