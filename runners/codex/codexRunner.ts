import { isAbsolute, relative } from 'node:path';
import { z } from 'zod';
import { EventQueue } from '../../daemon/runner/eventQueue.js';
import { finishRun, type TurnOutcome } from '../../daemon/runner/finishRun.js';
import {
  AgentReport,
  type RunEvent,
  type Runner,
  type RunTask,
  type TokenUsage,
} from '../../daemon/runner/runner.js';
import type { AppServerClient, LogLevel } from './appServerClient.js';

// Shapes below are checked against test/fixtures/codex/turn-*.jsonl (codex-cli 0.162.1).

const ThreadStartResponse = z.looseObject({ thread: z.looseObject({ id: z.string() }) });
const TurnStartResponse = z.looseObject({ turn: z.looseObject({ id: z.string() }) });

const TurnCompletedParams = z.looseObject({
  threadId: z.string(),
  turn: z.looseObject({
    id: z.string(),
    status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']),
    error: z.looseObject({ message: z.string() }).nullish(),
  }),
});

const ThreadItem = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('agentMessage'), text: z.string(), phase: z.string().nullish() }),
  z.looseObject({
    type: z.literal('commandExecution'),
    command: z.string(),
    status: z.string(),
    exitCode: z.number().nullish(),
  }),
  z.looseObject({
    type: z.literal('fileChange'),
    status: z.string(),
    changes: z.array(z.looseObject({ path: z.string() })),
  }),
]);

const ItemCompletedParams = z.looseObject({ threadId: z.string(), item: z.unknown() });

const ErrorParams = z.looseObject({
  threadId: z.string(),
  willRetry: z.boolean(),
  error: z.looseObject({ message: z.string() }),
});

const TokenUsageParams = z.looseObject({
  threadId: z.string(),
  tokenUsage: z.looseObject({
    total: z.looseObject({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
    }),
  }),
});

/** The JSON Schema Codex enforces on the final answer, without the `$schema` key. */
function outputSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete json.$schema;
  return json;
}

export interface CodexRunnerOptions {
  /** A started client. The runner shares it and never stops it. */
  client: AppServerClient;
  model?: string;
  /** Network access inside the sandbox. Off by default. */
  networkAccess?: boolean;
  /** A turn running longer than this is interrupted and reported as failed. */
  turnTimeoutMs?: number;
  log?: (level: LogLevel, message: string) => void;
}

type TurnEnd =
  { kind: 'completed' | 'interrupted' | 'failed'; error?: string } | { kind: 'crashed' };

/**
 * Runs one agent turn through `codex app-server`: an ephemeral thread in the task's worktree,
 * sandboxed to write only there, with no interactive approvals.
 */
export class CodexRunner implements Runner {
  readonly name = 'codex';
  readonly #client: AppServerClient;
  readonly #model: string | undefined;
  readonly #networkAccess: boolean;
  readonly #turnTimeoutMs: number;
  readonly #log: (level: LogLevel, message: string) => void;

  constructor(options: CodexRunnerOptions) {
    this.#client = options.client;
    this.#model = options.model;
    this.#networkAccess = options.networkAccess ?? false;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 60 * 60_000;
    this.#log = options.log ?? (() => undefined);
  }

  async *run(task: RunTask): AsyncIterable<RunEvent> {
    yield { type: 'started', runner: this.name };
    const events = new EventQueue<RunEvent>();
    const outcome = this.#execute(task, events).finally(() => {
      events.close();
    });
    yield* events;
    const report = await finishRun(task, await outcome);
    yield { type: 'report', report };
  }

  async #execute(task: RunTask, events: EventQueue<RunEvent>): Promise<TurnOutcome> {
    const cleanups: (() => void)[] = [];
    // Held in an object: TypeScript does not see assignments made inside callbacks.
    const turnState: { tokens?: TokenUsage; timedOut: boolean } = { timedOut: false };
    const withTokens = <T extends TurnOutcome>(o: T): T =>
      turnState.tokens ? { ...o, tokens: turnState.tokens } : o;
    try {
      if (task.signal?.aborted) return { kind: 'interrupted' };
      const cwd = task.workspace.path;
      const schema = task.readOnly?.schema ?? AgentReport;
      const { thread } = await this.#client.request(
        'thread/start',
        {
          cwd,
          approvalPolicy: 'never',
          sandbox: task.readOnly ? 'read-only' : 'workspace-write',
          ephemeral: true,
          ...(this.#model && { model: this.#model }),
        },
        ThreadStartResponse,
      );
      const threadId = thread.id;
      let finalAnswer: string | undefined;
      let lastError: string | undefined;

      const ended = new Promise<TurnEnd>((resolve) => {
        const on = (method: string, handler: (params: unknown) => void) => {
          cleanups.push(this.#client.onNotification(method, handler));
        };
        on('turn/completed', (params) => {
          const parsed = TurnCompletedParams.safeParse(params);
          if (!parsed.success || parsed.data.threadId !== threadId) return;
          const { status, error } = parsed.data.turn;
          if (status === 'inProgress') return;
          resolve({ kind: status, ...(error && { error: error.message }) });
        });
        on('item/completed', (params) => {
          const parsed = ItemCompletedParams.safeParse(params);
          if (!parsed.success || parsed.data.threadId !== threadId) return;
          const item = ThreadItem.safeParse(parsed.data.item);
          if (!item.success) return;
          const data = item.data;
          if (data.type === 'agentMessage') {
            if (data.phase === 'final_answer') finalAnswer = data.text;
            else events.push({ type: 'message', text: data.text });
          } else if (data.type === 'commandExecution') {
            events.push({
              type: 'command',
              command: data.command,
              exitCode: data.exitCode ?? null,
              status: data.status,
            });
          } else {
            events.push({
              type: 'file_change',
              paths: data.changes.map((change) => relativeToWorktree(cwd, change.path)),
              status: data.status,
            });
          }
        });
        on('error', (params) => {
          const parsed = ErrorParams.safeParse(params);
          if (!parsed.success || parsed.data.threadId !== threadId) return;
          if (!parsed.data.willRetry) lastError = parsed.data.error.message;
          events.push({ type: 'error', message: parsed.data.error.message });
        });
        on('thread/tokenUsage/updated', (params) => {
          const parsed = TokenUsageParams.safeParse(params);
          if (!parsed.success || parsed.data.threadId !== threadId) return;
          const { inputTokens, outputTokens, totalTokens } = parsed.data.tokenUsage.total;
          turnState.tokens = { input: inputTokens, output: outputTokens, total: totalTokens };
        });
        cleanups.push(
          this.#client.onStateChange((state) => {
            if (state === 'restarting' || state === 'stopped') resolve({ kind: 'crashed' });
          }),
        );
      });

      const { turn } = await this.#client.request(
        'turn/start',
        {
          threadId,
          input: [{ type: 'text', text: task.prompt, text_elements: [] }],
          sandboxPolicy: task.readOnly
            ? { type: 'readOnly', networkAccess: false }
            : {
                type: 'workspaceWrite',
                writableRoots: [cwd],
                networkAccess: this.#networkAccess,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
          outputSchema: outputSchemaFor(schema),
        },
        TurnStartResponse,
      );

      const interrupt = () => {
        this.#client
          .request('turn/interrupt', { threadId, turnId: turn.id }, z.unknown())
          .catch((error: unknown) => {
            this.#log('warn', `turn/interrupt failed: ${String(error)}`);
          });
      };
      const timer = setTimeout(() => {
        turnState.timedOut = true;
        interrupt();
      }, this.#turnTimeoutMs);
      cleanups.push(() => {
        clearTimeout(timer);
      });
      if (task.signal) {
        const signal = task.signal;
        signal.addEventListener('abort', interrupt, { once: true });
        cleanups.push(() => {
          signal.removeEventListener('abort', interrupt);
        });
        if (signal.aborted) interrupt();
      }

      const end = await ended;
      switch (end.kind) {
        case 'crashed':
          return withTokens({ kind: 'failed', error: 'codex app-server stoppede midt i turnen.' });
        case 'interrupted':
          return turnState.timedOut
            ? withTokens({
                kind: 'failed',
                error: `Turnen tog mere end ${String(Math.round(this.#turnTimeoutMs / 60_000))} min og blev afbrudt.`,
              })
            : withTokens({ kind: 'interrupted' });
        case 'failed':
          return withTokens({
            kind: 'failed',
            error: `Codex-turnen fejlede: ${end.error ?? lastError ?? 'ukendt fejl'}`,
          });
        default:
          return withTokens(parseFinalAnswer(finalAnswer, schema));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return withTokens({ kind: 'failed', error: message });
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  }
}

/** Paths inside the worktree are shown relative to it; anything else stays absolute. */
function relativeToWorktree(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel.startsWith('..') ? path : rel;
}

function parseFinalAnswer(text: string | undefined, schema: z.ZodType): TurnOutcome {
  if (text === undefined) return { kind: 'failed', error: 'Agenten afleverede ingen slutrapport.' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'failed', error: `Agentens slutrapport er ikke JSON: ${text.slice(0, 200)}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      kind: 'failed',
      error: `Agentens slutrapport har forkert form: ${z.prettifyError(parsed.error)}`,
    };
  }
  return { kind: 'completed', output: parsed.data };
}
