import type { GitHub } from '../github/github.js';
import { percent } from '../quota/policy.js';
import { percentLeft } from '../quota/quota.js';
import type { FactoryState } from './state.js';

export const STATUS_ISSUE_TITLE = 'Factory Status';
const MARKER = 'factory-status:v1';

const modeLabel: Record<FactoryState['mode'], string> = {
  running: 'Kører',
  idle: 'Ledig',
  paused: 'På pause',
  waiting_quota: 'Venter på kvote',
  error: 'Fejl',
};

function time(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('sv-SE', timeZone ? { timeZone } : {});
}

/**
 * The body of the pinned status issue: a human summary in Danish and the full state as JSON in an
 * HTML comment, which the dashboard's `github` mode (M5b) reads.
 */
export function renderStatusIssue(state: FactoryState, timeZone?: string): string {
  const lines = [
    `<!-- ${MARKER}`,
    JSON.stringify(state),
    '-->',
    '## Factory Status',
    '',
    `**Tilstand:** ${modeLabel[state.mode]}${state.reason ? ` – ${state.reason}` : ''}`,
    `**Heartbeat:** ${time(state.heartbeat, timeZone)} (vises som offline, hvis den er over 5 min gammel)`,
  ];
  if (state.mode === 'waiting_quota') {
    lines.push(
      `**Næste start:** ${state.nextStart ? time(state.nextStart, timeZone) : 'ukendt, kvoten tjekkes hvert 5. minut'}`,
    );
  }
  if (state.quota) {
    const { snapshot, pacing } = state.quota;
    const budget = pacing
      ? ` Dagens budget: ${percent(pacing.usedToday)} brugt af ${percent(pacing.budget)}.`
      : '';
    lines.push(
      `**Kvote:** ${percent(percentLeft(snapshot.fiveHour))} tilbage af 5-timersvinduet, ${percent(percentLeft(snapshot.weekly))} af ugen.${budget}`,
    );
  }
  if (state.quotaOverrideUntil) {
    lines.push(
      `**Boost:** kvotereglerne er tilsidesat til ${time(state.quotaOverrideUntil, timeZone)}. Kun Codex' egen kvote stopper fabrikken. \`/factory boost off\` slår reglerne til igen.`,
    );
  }
  if (state.focus) lines.push(`**Fokus:** ${state.focus}`);
  lines.push('', '### Arbejder på');
  const c = state.current;
  lines.push(
    c
      ? `[${c.project}#${String(c.issue)}](${c.url}) ${c.title} – workflow \`${c.workflow}\`, stage \`${c.stage}\` (${c.phase}), forsøg ${String(c.attempt)}`
      : '_Intet lige nu._',
  );
  lines.push('', '### Kø (Ready, i prioriteret rækkefølge)');
  lines.push(
    ...(state.queue.length > 0
      ? state.queue.map(
          (q) =>
            `- [${q.project}#${String(q.issue)}](${q.url}) ${q.title}${q.skip ? ` – _springes over: ${q.skip}_` : ''}`,
        )
      : ['_Tom._']),
  );
  lines.push('', '### Venter på dig');
  const kindLabel = {
    'needs-you': 'Venter på svar',
    blocked: 'Blokeret',
    'ready-to-merge': 'Klar til merge',
  } as const;
  lines.push(
    ...(state.waitingForYou.length > 0
      ? state.waitingForYou.map(
          (w) =>
            `- ${kindLabel[w.kind]}: ${w.url ? `[${w.project}#${String(w.issue)}](${w.url})` : `${w.project}#${String(w.issue)}`} ${w.text}`,
        )
      : ['_Intet._']),
  );
  if (state.log.length > 0) {
    lines.push(
      '',
      '<details><summary>Seneste log</summary>',
      '',
      '```',
      ...state.log.slice(-15),
      '```',
      '</details>',
    );
  }
  lines.push(
    '',
    '---',
    'Kommandoer (kun fra ejeren): `/factory pause | resume | status | halt | stop #N | retry #N [--runner x] | hold #N | focus <projekt>|off | workflow #N <navn> | reject #N "…" | approve #N | boost [3h|off]`',
  );
  return lines.join('\n');
}

/** Reads the state back out of a status issue body, or undefined if it has none. */
export function parseStatusIssue(body: string): FactoryState | undefined {
  const match = new RegExp(`<!-- ${MARKER}\\n(.*)\\n-->`).exec(body);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]) as FactoryState;
  } catch {
    return undefined;
  }
}

/** Finds or creates (and pins) the status issue once, then edits its body on every heartbeat. */
export class StatusIssue {
  #number: number | undefined;

  constructor(
    private readonly github: GitHub,
    private readonly repo: string,
    private readonly timeZone?: string,
  ) {}

  get number(): number | undefined {
    return this.#number;
  }

  async publish(state: FactoryState): Promise<number> {
    const body = renderStatusIssue(state, this.timeZone);
    if (this.#number === undefined) {
      const existing = await this.github.findOpenIssueByTitle(this.repo, STATUS_ISSUE_TITLE);
      if (existing) {
        this.#number = existing.number;
      } else {
        this.#number = await this.github.createIssue(this.repo, STATUS_ISSUE_TITLE, body);
        await this.github.pinIssue(this.repo, this.#number);
        return this.#number;
      }
    }
    await this.github.updateIssueBody(this.repo, this.#number, body);
    return this.#number;
  }
}
