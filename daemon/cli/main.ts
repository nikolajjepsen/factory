import { openCodexQuotaSource } from '../../runners/codex/codexQuotaSource.js';
import { createProgram } from './program.js';
import {
  attempts,
  clientInfo,
  log,
  runSingleRole,
  runWorkflow,
  validateWorkflows,
} from './wiring.js';

await createProgram({
  openQuotaSource: () => openCodexQuotaSource({ clientInfo, log }),
  runIssue: runSingleRole,
  runWorkflow,
  validateWorkflows,
  attempts,
}).parseAsync(process.argv);
