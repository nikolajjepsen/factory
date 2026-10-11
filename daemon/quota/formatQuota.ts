import { percentLeft, type QuotaSnapshot, type QuotaWindow } from './quota.js';

export interface FormatOptions {
  now: Date;
  /** IANA time zone. Defaults to the machine's own. */
  timeZone?: string;
}

const LOCALE = 'da-DK';

function calendarDay(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which compares as plain strings.
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(date);
}

function formatTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    date,
  );
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${String(days)} d ${String(hours)} t`;
  if (hours > 0) return `${String(hours)} t ${String(minutes)} min`;
  return `${String(minutes)} min`;
}

/** "i dag kl. 22.30 (om 4 t 9 min)" or "lør. 17. okt. kl. 18.10 (om 6 d 0 t)". */
export function formatResetTime(iso: string | null, options: FormatOptions): string {
  if (iso === null) return 'nulstillingstid ukendt';
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Date(iso);
  const tomorrow = new Date(options.now.getTime() + 86_400_000);
  const day = calendarDay(date, timeZone);
  const dayLabel =
    day === calendarDay(options.now, timeZone)
      ? 'i dag'
      : day === calendarDay(tomorrow, timeZone)
        ? 'i morgen'
        : new Intl.DateTimeFormat(LOCALE, {
            timeZone,
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          }).format(date);
  const remaining = date.getTime() - options.now.getTime();
  const relative = remaining > 0 ? `om ${formatDuration(remaining)}` : 'nu';
  return `${dayLabel} kl. ${formatTime(date, timeZone)} (${relative})`;
}

function formatWindow(label: string, window: QuotaWindow, options: FormatOptions): string {
  const left = `${String(Math.round(percentLeft(window)))} % tilbage`;
  return `${label.padEnd(9)}${left.padStart(14)}   nulstilles ${formatResetTime(window.resetsAt, options)}`;
}

/** The text `factory quota` prints. */
export function formatQuota(snapshot: QuotaSnapshot, options: FormatOptions): string {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fetchedAt = new Date(snapshot.fetchedAt);
  // Date and time are formatted separately: ICU's pattern for joining them varies by version.
  const fetchedDate = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(fetchedAt);
  return [
    `Codex-kvote (hentet ${fetchedDate} kl. ${formatTime(fetchedAt, timeZone)})`,
    formatWindow('5 timer', snapshot.fiveHour, options),
    formatWindow('Uge', snapshot.weekly, options),
  ].join('\n');
}
