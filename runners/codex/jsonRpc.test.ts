import { describe, expect, it } from 'vitest';
import { errorLines, transcript } from '../../test/support/fixtures.js';
import { classifyMessage } from './jsonRpc.js';

const classify = (line: string) => classifyMessage(JSON.parse(line));

describe('classifyMessage', () => {
  it('classifies the recorded app-server transcript', () => {
    expect(transcript.map((line) => classify(line)?.kind)).toEqual([
      'success',
      'notification',
      'success',
      'notification',
    ]);
    expect(classify(transcript[1] ?? '')).toMatchObject({
      kind: 'notification',
      method: 'remoteControl/status/changed',
    });
  });

  it('classifies recorded error answers, with string and number ids', () => {
    expect(errorLines.map((line) => classify(line))).toEqual([
      { kind: 'error', id: 'pre', error: { code: -32600, message: 'Not initialized' } },
      expect.objectContaining({ kind: 'error', id: 'bogus' }),
      { kind: 'error', id: 0, error: { code: -32600, message: 'Already initialized' } },
    ]);
  });

  it('treats a message with both id and method as a server request', () => {
    expect(classifyMessage({ id: 7, method: 'item/tool/call', params: { x: 1 } })).toEqual({
      kind: 'request',
      id: 7,
      method: 'item/tool/call',
      params: { x: 1 },
    });
  });

  it('accepts a null result', () => {
    expect(classifyMessage({ id: 1, result: null })).toEqual({
      kind: 'success',
      id: 1,
      result: null,
    });
  });

  it('rejects values that are not JSON-RPC messages', () => {
    expect(classifyMessage({ id: 1 })).toBeUndefined();
    expect(classifyMessage({ foo: 'bar' })).toBeUndefined();
    expect(classifyMessage([1, 2])).toBeUndefined();
    expect(classifyMessage('text')).toBeUndefined();
    expect(classifyMessage({ id: 1, error: { message: 'no code' } })).toBeUndefined();
  });
});
