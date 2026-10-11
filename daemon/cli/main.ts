import { openCodexQuotaSource } from '../../runners/codex/codexQuotaSource.js';
import { createProgram, version } from './program.js';

const clientInfo = { name: 'ai_factory', title: 'ai-factory', version };

const log = (level: string, message: string) => {
  if (level === 'warn' || level === 'error') process.stderr.write(`[${level}] ${message}\n`);
};

await createProgram({
  openQuotaSource: () => openCodexQuotaSource({ clientInfo, log }),
}).parseAsync(process.argv);
