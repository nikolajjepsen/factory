import { describe, expect, it } from 'vitest';
import { Command, parseChatOps } from './commands.js';

const parse = (body: string, context = {}) => parseChatOps(body, context);

describe('parseChatOps', () => {
  it('parses commands without arguments', () => {
    expect(
      parse('/factory pause\n/factory resume\n/factory status\n/factory halt').commands,
    ).toEqual([
      { command: 'pause' },
      { command: 'resume' },
      { command: 'status' },
      { command: 'halt' },
    ]);
  });

  it('parses issue references in every form', () => {
    expect(parse('/factory stop #24').commands).toEqual([{ command: 'stop', issue: 24 }]);
    expect(parse('/factory hold loge-app#25').commands).toEqual([
      { command: 'hold', issue: 25, project: 'loge-app' },
    ]);
    expect(parse('/factory approve nikolajjepsen/ekvilibrium#6').commands).toEqual([
      { command: 'approve', issue: 6, project: 'nikolajjepsen/ekvilibrium' },
    ]);
  });

  it('uses the issue and project of the comment when the command names no issue', () => {
    expect(parse('/factory stop', { issue: 7, project: 'ekvilibrium' }).commands).toEqual([
      { command: 'stop', issue: 7, project: 'ekvilibrium' },
    ]);
    expect(parse('/factory retry #9', { issue: 7, project: 'ekvilibrium' }).commands).toEqual([
      { command: 'retry', issue: 9, project: 'ekvilibrium' },
    ]);
  });

  it('parses retry --runner, focus, workflow and reject feedback', () => {
    expect(parse('/factory retry #24 --runner claude').commands).toEqual([
      { command: 'retry', issue: 24, runner: 'claude' },
    ]);
    expect(parse('/factory focus loge-app').commands).toEqual([
      { command: 'focus', project: 'loge-app' },
    ]);
    expect(parse('/factory focus off').commands).toEqual([{ command: 'focus' }]);
    expect(parse('/factory workflow #3 bugfix').commands).toEqual([
      { command: 'workflow', issue: 3, workflow: 'bugfix' },
    ]);
    expect(parse('/factory reject #3 "Brug Math.min, ikke if/else"').commands).toEqual([
      { command: 'reject', issue: 3, feedback: 'Brug Math.min, ikke if/else' },
    ]);
    expect(parse('/factory reject Mangler test', { issue: 3 }).commands).toEqual([
      { command: 'reject', issue: 3, feedback: 'Mangler test' },
    ]);
  });

  it('only reads lines that start with /factory', () => {
    expect(parse('Svar med `/factory approve #12` eller\n  /factory pause').commands).toEqual([
      { command: 'pause' },
    ]);
  });

  it('reports unknown commands, missing issues and stray words', () => {
    const { commands, errors } = parse(
      '/factory dance\n/factory stop\n/factory pause now\n/factory\n/factory retry #1 --runner',
    );
    expect(commands).toEqual([]);
    expect(errors).toEqual([
      '"/factory dance": ukendt kommando "dance". Kendte: pause, resume, status, halt, stop, retry, hold, focus, workflow, reject, approve.',
      '"/factory stop": /factory stop needs an issue, e.g. #12',
      '"/factory pause now": uventede ord: now.',
      '"/factory": mangler en kommando.',
      '"/factory retry #1 --runner": --runner mangler et navn.',
    ]);
  });
});

describe('Command schema', () => {
  it('accepts the daemon API shape from BUILD_PLAN.md', () => {
    expect(
      Command.parse({ command: 'retry', issue: 24, project: 'loge-app', runner: 'claude' }),
    ).toEqual({
      command: 'retry',
      issue: 24,
      project: 'loge-app',
      runner: 'claude',
    });
    expect(Command.safeParse({ command: 'hold' }).success).toBe(false);
    expect(Command.safeParse({ command: 'explode' }).success).toBe(false);
  });
});
