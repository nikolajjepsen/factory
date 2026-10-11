import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The daemon API's bearer token in `~/.ai-factory/api-token`. Created on first use with 256 random
 * bits, readable only by the owner. An existing file is tightened to 0600 if needed.
 */
export async function loadOrCreateToken(file: string): Promise<string> {
  try {
    const token = (await readFile(file, 'utf8')).trim();
    if (token.length > 0) {
      await chmod(file, 0o600);
      return token;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(file), { recursive: true });
  const token = randomBytes(32).toString('base64url');
  try {
    await writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Another process created it first: use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateToken(file);
    throw error;
  }
  return token;
}
