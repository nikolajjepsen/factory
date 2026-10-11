import {
  type FactoryState,
  isOffline,
  type QueueEntry,
  type QuotaWindow,
  type TodayStats,
  type WaitingEntry,
} from '@ai-factory/protocol';

// Pure view logic for the control room, tested without a browser.

export type Tone = 'ok' | 'warn' | 'crit' | 'neutral' | 'accent';

export interface SourceStatus {
  mode: 'direct' | 'github';
  connected: boolean;
  error: string | null;
  updatedAt: string | null;
}

export function greeting(now: Date, name: string | null): string {
  const hour = now.getHours();
  const word =
    hour < 5
      ? 'God nat'
      : hour < 10
        ? 'God morgen'
        : hour < 12
          ? 'God formiddag'
          : hour < 18
            ? 'God eftermiddag'
            : 'God aften';
  return name ? `${word}, ${name}` : word;
}

/** "12 s", "4 min", "3 t". */
export function ago(iso: string, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  return `${String(Math.round(minutes / 60))} t`;
}

/** "22.30", or "søn. 22.30" when not today. */
export function clock(iso: string, now: Date): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (date.toDateString() === tomorrow.toDateString()) return `i morgen ${time}`;
  return `${date.toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export interface ModeView {
  label: string;
  tone: Tone;
  subtitle: string;
  banner?: { title: string; text: string; tone: 'warn' | 'crit' };
  /** Whether the main button resumes (true) or pauses (false). */
  resumes: boolean;
}

/** The status pill, the line under the greeting, the banner and the pause button. */
export function modeView(state: FactoryState, now: Date): ModeView {
  const waiting = state.waitingForYou.length;
  const forYou =
    waiting === 0
      ? ''
      : waiting === 1
        ? ' 1 ting venter på dig.'
        : ` ${String(waiting)} ting venter på dig.`;
  if (isOffline(state, now)) {
    return {
      label: 'Offline',
      tone: 'crit',
      subtitle: 'Daemonen melder sig ikke.',
      banner: {
        title: 'Daemonen er offline.',
        text: `Seneste heartbeat for ${ago(state.heartbeat, now)} siden. Kører \`factory daemon\`?`,
        tone: 'crit',
      },
      resumes: false,
    };
  }
  if (state.halted) {
    return {
      label: 'Nødstop',
      tone: 'crit',
      subtitle: 'Alt er stoppet. Arbejdet er gemt på branchen.',
      banner: {
        title: 'Nødstop aktivt.',
        text: `${state.reason ?? ''} Tryk Genoptag for at fortsætte. Et factory:halt-label skal du selv fjerne.`.trim(),
        tone: 'crit',
      },
      resumes: true,
    };
  }
  switch (state.mode) {
    case 'running':
      return {
        label: 'Kører',
        tone: 'ok',
        subtitle: `Fabrikken kører stille og roligt.${forYou}`,
        resumes: false,
      };
    case 'idle':
      return {
        label: 'Ledig',
        tone: 'ok',
        subtitle: `Intet i køen lige nu.${forYou}`,
        resumes: false,
      };
    case 'paused':
      return {
        label: 'Pauset',
        tone: 'warn',
        subtitle: 'Fabrikken holder pause.',
        banner: {
          title: 'Pauset.',
          text: 'Ingen nye trin startes, før du genoptager.',
          tone: 'warn',
        },
        resumes: true,
      };
    case 'waiting_quota': {
      const when = state.nextStart ? clock(state.nextStart, now) : null;
      return {
        label: 'Venter på kvote',
        tone: 'warn',
        subtitle: when ? `Fabrikken sover til ${when}.` : 'Fabrikken venter på kvote.',
        banner: {
          title: 'Venter på kvote.',
          text: `${state.reason ?? ''}${when ? ` Fortsætter selv ${when}.` : ' Kvoten tjekkes hvert 5. minut.'}`.trim(),
          tone: 'warn',
        },
        resumes: false,
      };
    }
    case 'error':
      return {
        label: 'Fejl',
        tone: 'crit',
        subtitle: 'Seneste gennemløb fejlede. Daemonen prøver igen.',
        banner: { title: 'Fejl.', text: state.reason ?? 'Ukendt fejl.', tone: 'crit' },
        resumes: false,
      };
  }
}

/** 20 █-blocks like Codex' /status, coloured by what is left. */
export function quotaBar(window: QuotaWindow): {
  left: number;
  filled: string;
  empty: string;
  tone: Tone;
} {
  const left = Math.round(Math.min(100, Math.max(0, 100 - window.usedPercent)));
  const blocks = Math.round(left / 5);
  return {
    left,
    filled: '█'.repeat(blocks),
    empty: '█'.repeat(20 - blocks),
    tone: left < 15 ? 'crit' : left < 50 ? 'warn' : 'ok',
  };
}

export function percent(value: number): string {
  return `${value.toLocaleString('da-DK', { maximumFractionDigits: 1 })} %`;
}

/** "4 PR'er · 2 merged · first-pass 71 %". */
export function todayLine(today: TodayStats): string {
  const prs = today.prs === 1 ? '1 PR' : `${String(today.prs)} PR'er`;
  const firstPass = today.firstPass === null ? '' : ` · first-pass ${String(today.firstPass)} %`;
  return `${prs} · ${String(today.merged)} merged${firstPass}`;
}

/** A log line "20:13:51 text" as time (hh:mm), text and colour. */
export function logLine(line: string): { time: string; text: string; tone: Tone } {
  const match = /^(\d{2}:\d{2})(?::\d{2})? (.*)$/.exec(line);
  const time = match?.[1] ?? '';
  const text = match?.[2] ?? line;
  const tone: Tone = /Fejl|fejlede|Nødbremse|Blokeret|gået i stå|[Kk]unne ikke/.test(text)
    ? 'crit'
    : /bestået|Færdig|godkendt|kører igen|PR: /.test(text)
      ? 'ok'
      : /fejlet|venter|pause|kvote|stoppet|stige|Afbr/i.test(text)
        ? 'warn'
        : 'neutral';
  return { time, text, tone };
}

export function queueMeta(entry: QueueEntry): string {
  if (entry.held) return 'på hold · springes over';
  return entry.skip ?? 'klar';
}

/** The meta text next to a project in the sidebar. */
export function projectMeta(name: string, state: FactoryState): { text: string; tone: Tone } {
  if (state.current?.project === name) return { text: 'aktiv', tone: 'ok' };
  if (state.projects.find((p) => p.name === name)?.enabled === false)
    return { text: 'slukket', tone: 'neutral' };
  if (state.focus === name) return { text: 'fokus', tone: 'accent' };
  const queued = state.queue.filter((q) => q.project === name && !q.skip).length;
  return { text: queued > 0 ? `${String(queued)} i kø` : '', tone: 'neutral' };
}

export interface WaitingView {
  icon: string;
  title: string;
  kind: string;
  /** The primary action: a command, or a link. */
  action: { label: string; command: 'approve' | 'retry' } | { label: string; href: string } | null;
  /** Whether "Afvis" with feedback is offered. */
  canReject: boolean;
}

export function waitingView(entry: WaitingEntry): WaitingView {
  const title = `${entry.project}#${String(entry.issue)}`;
  switch (entry.kind) {
    case 'needs-you':
      return {
        icon: '?',
        title,
        kind: capitalize(entry.text),
        action: { label: 'Godkend', command: 'approve' },
        canReject: true,
      };
    case 'blocked':
      return {
        icon: '!',
        title,
        kind: `Blokeret: ${entry.text}`,
        action: { label: 'Prøv igen', command: 'retry' },
        canReject: true,
      };
    case 'ready-to-merge':
      return {
        icon: '✓',
        title,
        kind: 'CI grøn og reviewet. Klar til merge.',
        action: entry.url ? { label: 'Åbn PR', href: entry.url } : null,
        canReject: false,
      };
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The runner "switch runner" moves to, or null when there is nothing to switch to. */
export function nextRunner(runners: readonly string[], current: string): string | null {
  if (runners.length < 2) return null;
  const at = runners.indexOf(current);
  return runners[(at + 1) % runners.length] ?? null;
}

/** "Direkte · live", "GitHub · status 34 s gammel". */
export function sourceLine(
  source: SourceStatus,
  state: FactoryState | null,
  now: Date,
): { text: string; tone: Tone } {
  const name = source.mode === 'direct' ? 'Direkte' : 'GitHub';
  if (!source.connected)
    return { text: `${name} · ${source.error ?? 'forbinder …'}`, tone: 'crit' };
  if (source.mode === 'direct') return { text: `${name} · live`, tone: 'ok' };
  const age = state ? ago(state.heartbeat, now) : '?';
  return { text: `${name} · status ${age} gammel`, tone: 'warn' };
}
