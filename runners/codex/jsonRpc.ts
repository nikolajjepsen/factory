import { z } from 'zod';

// `codex app-server` speaks JSON-RPC 2.0 over JSONL but omits the `"jsonrpc": "2.0"` field.
// See test/fixtures/codex/ for recorded traffic.

export const RequestId = z.union([z.string(), z.number()]);
export type RequestId = z.infer<typeof RequestId>;

export const RpcErrorBody = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcErrorBody = z.infer<typeof RpcErrorBody>;

const Envelope = z.object({
  id: RequestId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: RpcErrorBody.optional(),
});

export type IncomingMessage =
  | { kind: 'request'; id: RequestId; method: string; params: unknown }
  | { kind: 'success'; id: RequestId; result: unknown }
  | { kind: 'error'; id: RequestId; error: RpcErrorBody }
  | { kind: 'notification'; method: string; params: unknown };

/** Classifies one decoded JSONL line. Returns undefined when it is not a JSON-RPC message. */
export function classifyMessage(value: unknown): IncomingMessage | undefined {
  const parsed = Envelope.safeParse(value);
  if (!parsed.success) return undefined;
  const { id, method, params, result, error } = parsed.data;
  if (method !== undefined) {
    return id === undefined
      ? { kind: 'notification', method, params }
      : { kind: 'request', id, method, params };
  }
  if (id === undefined) return undefined;
  if (error !== undefined) return { kind: 'error', id, error };
  // `result` may legitimately be null, so check for the key rather than the value.
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return { kind: 'success', id, result };
  }
  return undefined;
}

/** JSON-RPC error codes the client itself sends back. */
export const RpcErrorCode = {
  methodNotFound: -32601,
} as const;
