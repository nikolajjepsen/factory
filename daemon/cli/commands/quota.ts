import type { Command } from 'commander';
import { formatQuota } from '../../quota/formatQuota.js';
import type { QuotaSource } from '../../quota/quota.js';

export interface QuotaCommandSource extends QuotaSource {
  /** The source's own unparsed answer, for recording fixtures. */
  readRaw(): Promise<unknown>;
}

export interface QuotaCommandDeps {
  openQuotaSource: () => Promise<QuotaCommandSource>;
  now: () => Date;
  stdout: (text: string) => void;
  timeZone?: string;
}

export function registerQuotaCommand(program: Command, deps: QuotaCommandDeps): void {
  program
    .command('quota')
    .description('vis Codex-kvoten: % tilbage og nulstillingstid for 5-timers- og ugevinduet')
    .option('--json', 'udskriv det normaliserede snapshot som JSON')
    .option('--raw', 'udskriv det rå svar fra codex app-server (til fixtures)')
    .action(async (options: { json?: boolean; raw?: boolean }, command: Command) => {
      let source: QuotaCommandSource | undefined;
      try {
        source = await deps.openQuotaSource();
        let text: string;
        if (options.raw) {
          text = JSON.stringify(await source.readRaw(), null, 2);
        } else {
          const snapshot = await source.read();
          text = options.json
            ? JSON.stringify(snapshot, null, 2)
            : formatQuota(snapshot, { now: deps.now(), timeZone: deps.timeZone });
        }
        deps.stdout(`${text}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        command.error(`Kunne ikke læse kvoten fra Codex: ${message}`, { exitCode: 1 });
      } finally {
        await source?.close();
      }
    });
}
