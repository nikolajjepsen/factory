import { readJsonlFixture } from './fixtures.js';

interface Recorded {
  dir: 'in' | 'out';
  msg: { id?: number; method?: string; params?: unknown; result?: unknown };
}

export interface TurnFixture {
  threadStartResult: unknown;
  turnStartResult: unknown;
  /** Server notifications after the turn/start answer, in recorded order. */
  notifications: { method: string; params?: unknown }[];
}

/** Splits a recorded turn (test/fixtures/codex/turn-*.jsonl) into what a fake server replays. */
export function loadTurnFixture(name: string): TurnFixture {
  const lines = readJsonlFixture(`codex/${name}`).map((line) => JSON.parse(line) as Recorded);
  const outId = (method: string) =>
    lines.find((l) => l.dir === 'out' && l.msg.method === method)?.msg.id;
  const answer = (method: string) => {
    const id = outId(method);
    const index = lines.findIndex((l) => l.dir === 'in' && l.msg.id === id && 'result' in l.msg);
    if (index < 0) throw new Error(`${name} has no answer to ${method}`);
    return { index, result: lines[index]?.msg.result };
  };
  const threadStart = answer('thread/start');
  const turnStart = answer('turn/start');
  const notifications = lines
    .slice(turnStart.index + 1)
    .filter((l) => l.dir === 'in' && l.msg.id === undefined && l.msg.method !== undefined)
    .map((l) => ({ method: l.msg.method ?? '', params: l.msg.params }));
  return {
    threadStartResult: threadStart.result,
    turnStartResult: turnStart.result,
    notifications,
  };
}
