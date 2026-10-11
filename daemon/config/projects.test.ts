import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome, factoryHome, loadProject, loadProjects } from './projects.js';

async function projectsFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ai-factory-projects-'));
  const file = join(dir, 'projects.yml');
  await writeFile(file, content);
  return file;
}

describe('loadProjects', () => {
  it('reads projects and resolves ~ and relative paths', async () => {
    const file = await projectsFile(
      'projects:\n  loge-app:\n    repo: nikolajjepsen/loge-app\n    path: ~/dev/loge-app\n  local:\n    repo: o/local\n    path: ../local\n',
    );
    const projects = await loadProjects(file);
    expect(projects.get('loge-app')).toEqual({
      name: 'loge-app',
      repo: 'nikolajjepsen/loge-app',
      path: join(homedir(), 'dev/loge-app'),
    });
    expect(projects.get('local')?.path).toBe(join(file, '../../local'));
  });

  it('explains invalid files', async () => {
    const badName = await projectsFile('projects:\n  Bad_Name:\n    repo: o/r\n    path: x\n');
    await expect(loadProjects(badName)).rejects.toThrow(
      'projektnavnet "Bad_Name" skal være kebab-case',
    );
    const badRepo = await projectsFile('projects:\n  ok:\n    repo: not-a-repo\n    path: x\n');
    await expect(loadProjects(badRepo)).rejects.toThrow(/er ugyldig[\s\S]*owner\/name/);
  });

  it('explains a missing file', async () => {
    await expect(loadProjects('/nonexistent/projects.yml')).rejects.toThrow(/findes ikke/);
  });
});

describe('loadProject', () => {
  it('lists the known projects when the name is unknown', async () => {
    const file = await projectsFile('projects:\n  a:\n    repo: o/a\n    path: /a\n');
    await expect(loadProject(file, 'b')).rejects.toThrow('Ukendt projekt "b". Kendte projekter i');
    await expect(loadProject(file, 'a')).resolves.toMatchObject({ repo: 'o/a' });
  });
});

describe('paths', () => {
  it('expands ~ and honours AI_FACTORY_HOME', () => {
    expect(expandHome('~/x')).toBe(join(homedir(), 'x'));
    expect(expandHome('/abs')).toBe('/abs');
    expect(factoryHome({ AI_FACTORY_HOME: '/custom' })).toBe('/custom');
    expect(factoryHome({})).toBe(join(homedir(), '.ai-factory'));
  });
});
