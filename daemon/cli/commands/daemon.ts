import type { Command } from 'commander';

export interface DaemonCommandDeps {
  runDaemon: (options: { once: boolean }, signal: AbortSignal) => Promise<void>;
  installService: () => Promise<string>;
  uninstallService: () => Promise<void>;
  /** The daemon API's bearer token, created on first use. */
  apiToken: () => Promise<{ token: string; file: string }>;
  /** Subscribes to SIGINT and SIGTERM. Returns an unsubscribe function. */
  onShutdown: (handler: () => void) => () => void;
  stdout: (text: string) => void;
}

export function registerDaemonCommands(program: Command, deps: DaemonCommandDeps): void {
  program
    .command('daemon')
    .description('kør fabrikkens daemon: henter arbejde fra boardet, til den stoppes')
    .option('--once', 'kør kun ét gennemløb og stop')
    .action(async (options: { once?: boolean }) => {
      const controller = new AbortController();
      const unsubscribe = deps.onShutdown(() => {
        deps.stdout('Stopper daemonen. Et kørende trin gemmes som WIP …\n');
        controller.abort();
      });
      try {
        await deps.runDaemon({ once: options.once ?? false }, controller.signal);
      } finally {
        unsubscribe();
      }
    });

  program
    .command('api-token')
    .description('vis bearer-tokenet til daemonens API (oprettes første gang)')
    .action(async () => {
      const { token } = await deps.apiToken();
      deps.stdout(`${token}\n`);
    });

  program
    .command('install-service')
    .description('installér daemonen som launchd-agent, så den kører døgnet rundt')
    .action(async () => {
      const path = await deps.installService();
      deps.stdout(`Installeret og startet: ${path}\nLog: ~/.ai-factory/logs/daemon.log\n`);
    });

  program
    .command('uninstall-service')
    .description('stop og fjern launchd-agenten')
    .action(async () => {
      await deps.uninstallService();
      deps.stdout('launchd-agenten er stoppet og fjernet.\n');
    });
}
