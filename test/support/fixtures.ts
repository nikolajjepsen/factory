import { readFileSync } from 'node:fs';

const fixtureUrl = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);

export function readJsonFixture(name: string): unknown {
  return JSON.parse(readFileSync(fixtureUrl(name), 'utf8'));
}

export function readJsonlFixture(name: string): string[] {
  return readFileSync(fixtureUrl(name), 'utf8').split('\n').filter(Boolean);
}

/** Recorded server output from a real `codex app-server` session. */
export const transcript = readJsonlFixture('codex/app-server-transcript.jsonl');
export const transcriptMessages = transcript.map(
  (line) => JSON.parse(line) as Record<string, unknown>,
);
export const initializeResult = transcriptMessages[0]?.result;
export const rateLimitsResult = readJsonFixture('codex/rate-limits-read.json');
export const errorLines = readJsonlFixture('codex/app-server-errors.jsonl');
