// A stand-in for `codex app-server` that replays the recorded transcript over real stdio.
// Usage: node --import tsx fakeAppServer.ts [--crash-after-initialize]
import { createInterface } from 'node:readline';
import { initializeResult, rateLimitsResult, transcriptMessages } from './fixtures.js';

const crashAfterInitialize = process.argv.includes('--crash-after-initialize');
const write = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

process.stderr.write('fake app-server started\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line) as { id?: number; method?: string };
  switch (message.method) {
    case 'initialize':
      write({ id: message.id, result: initializeResult });
      // Unsolicited notifications, as the real server sends them.
      for (const notification of transcriptMessages.filter((m) => !('id' in m))) {
        write(notification);
      }
      break;
    case 'initialized':
      if (crashAfterInitialize) {
        process.stderr.write('fake app-server crashing\n');
        process.exit(3);
      }
      break;
    case 'account/rateLimits/read':
      write({ id: message.id, result: rateLimitsResult });
      break;
    default:
      write({
        id: message.id,
        error: { code: -32600, message: `unknown method ${String(message.method)}` },
      });
  }
});
