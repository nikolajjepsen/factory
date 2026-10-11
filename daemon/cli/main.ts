import { openCodexQuotaSource } from '../../runners/codex/codexQuotaSource.js';
import { createProgram } from './program.js';
import {
  attempts,
  clientInfo,
  installService,
  log,
  runDaemon,
  runSingleRole,
  runWorkflow,
  uninstallService,
  validateWorkflows,
} from './wiring.js';

await createProgram({
  openQuotaSource: () => openCodexQuotaSource({ clientInfo, log }),
  runIssue: runSingleRole,
  runWorkflow,
  validateWorkflows,
  attempts,
  runDaemon,
  installService,
  uninstallService,
}).parseAsync(process.argv);
