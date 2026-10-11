import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ConnectionExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started at all, for example when `codex` is missing. */
  spawnError?: Error;
  /** The last lines the process wrote to stderr, for error messages. */
  stderrTail: string[];
}

/** One running app-server process, seen as a stream of lines. Tests replace it with a fake. */
export interface AppServerConnection {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (exit: ConnectionExit) => void): void;
  kill(): void;
}

export type ConnectionFactory = () => AppServerConnection;

export interface SpawnOptions {
  command?: string;
  args?: string[];
  stderrTailLines?: number;
}

export function spawnAppServer(options: SpawnOptions = {}): AppServerConnection {
  const { command = 'codex', args = ['app-server'], stderrTailLines = 20 } = options;
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderrTail: string[] = [];
  const lineListeners: ((line: string) => void)[] = [];
  const exitListeners: ((exit: ConnectionExit) => void)[] = [];
  let exited = false;

  const emitExit = (exit: Omit<ConnectionExit, 'stderrTail'>) => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ ...exit, stderrTail: [...stderrTail] });
  };

  createInterface({ input: child.stdout }).on('line', (line) => {
    for (const listener of lineListeners) listener(line);
  });
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderrTail.push(line);
    if (stderrTail.length > stderrTailLines) stderrTail.shift();
  });
  // A write after the process died raises EPIPE here. The exit event reports the real cause.
  child.stdin.on('error', () => undefined);
  child.on('error', (error) => {
    emitExit({ code: null, signal: null, spawnError: error });
  });
  // 'close' fires after stdout and stderr are drained, so no line arrives after the exit event.
  child.on('close', (code, signal) => {
    emitExit({ code, signal });
  });

  return {
    send(line) {
      if (!exited) child.stdin.write(`${line}\n`);
    },
    onLine(listener) {
      lineListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    kill() {
      child.kill();
    },
  };
}
