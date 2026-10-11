// Composition root: the only place that wires concrete runners and services to the core.
import { join } from 'node:path';
import { factoryHome, factoryRoot, loadProject } from '../config/projects.js';
import { OctokitGitHub } from '../github/github.js';
import { runIssue } from '../run/runIssue.js';
import { WorktreeManager } from '../workspace/workspace.js';
import { AppServerClient } from '../../runners/codex/appServerClient.js';
import { openCodexQuotaSource } from '../../runners/codex/codexQuotaSource.js';
import { CodexRunner } from '../../runners/codex/codexRunner.js';
import { createProgram, version } from './program.js';

const clientInfo = { name: 'ai_factory', title: 'ai-factory', version };
const projectsFile = process.env.FACTORY_PROJECTS_FILE ?? join(factoryRoot, 'projects.yml');

const log = (level: string, message: string) => {
  if (level === 'warn' || level === 'error') process.stderr.write(`[${level}] ${message}\n`);
};

await createProgram({
  openQuotaSource: () => openCodexQuotaSource({ clientInfo, log }),
  runIssue: async (options, onEvent, signal) => {
    const project = await loadProject(projectsFile, options.project);
    const github = await OctokitGitHub.fromGhCli();
    const client = new AppServerClient({ clientInfo, log });
    await client.start();
    try {
      const runner = new CodexRunner({
        client,
        log,
        ...(options.model && { model: options.model }),
        ...(options.network && { networkAccess: true }),
      });
      return await runIssue(
        {
          github,
          runner,
          worktrees: new WorktreeManager(join(factoryHome(), 'worktrees')),
          agentsDir: join(factoryRoot, 'agents'),
        },
        { project, issue: options.issue, role: options.role, signal, onEvent },
      );
    } finally {
      await client.stop();
    }
  },
}).parseAsync(process.argv);
