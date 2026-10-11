import { describe, expect, it } from 'vitest';
import { sampleState } from '../test/sample.js';
import {
  ago,
  greeting,
  logLine,
  modeView,
  nextRunner,
  projectMeta,
  queueMeta,
  quotaBar,
  sourceLine,
  todayLine,
  waitingView,
} from './model.js';

const now = new Date('2026-10-11T20:00:00.000Z');

function never(): never {
  throw new Error('missing sample entry');
}

describe('control room view model', () => {
  it('greets by the time of day', () => {
    expect(greeting(new Date(2026, 9, 11, 21), 'Nikolaj')).toBe('God aften, Nikolaj');
    expect(greeting(new Date(2026, 9, 11, 7), null)).toBe('God morgen');
    expect(greeting(new Date(2026, 9, 11, 3), null)).toBe('God nat');
  });

  it('shows the quota as 20 blocks coloured by what is left', () => {
    expect(quotaBar({ usedPercent: 61, resetsAt: null })).toEqual({
      left: 39,
      filled: '█'.repeat(8),
      empty: '█'.repeat(12),
      tone: 'warn',
    });
    expect(quotaBar({ usedPercent: 90, resetsAt: null }).tone).toBe('crit');
    expect(quotaBar({ usedPercent: 10, resetsAt: null }).tone).toBe('ok');
  });

  it('describes every mode, and offline and halt before the mode', () => {
    expect(modeView(sampleState(), now)).toMatchObject({
      label: 'Kører',
      tone: 'ok',
      resumes: false,
    });
    expect(modeView(sampleState(), now).subtitle).toBe(
      'Fabrikken kører stille og roligt. 2 ting venter på dig.',
    );
    expect(modeView(sampleState({ mode: 'paused' }), now)).toMatchObject({
      label: 'Pauset',
      resumes: true,
      banner: { tone: 'warn' },
    });
    // Local times, so the test passes in any time zone (CI runs in UTC).
    const evening = new Date(2026, 9, 11, 22, 0);
    const quota = modeView(
      sampleState({
        mode: 'waiting_quota',
        reason: 'Dagens budget er brugt.',
        heartbeat: new Date(evening.getTime() - 12_000).toISOString(),
        nextStart: new Date(2026, 9, 12, 0, 0).toISOString(),
      }),
      evening,
    );
    expect(quota.label).toBe('Venter på kvote');
    expect(quota.banner?.text).toMatch(
      /^Dagens budget er brugt\. Fortsætter selv i morgen 00[.:]00\.$/,
    );
    expect(modeView(sampleState({ halted: true, mode: 'paused' }), now)).toMatchObject({
      label: 'Nødstop',
      resumes: true,
    });
    expect(modeView(sampleState({ heartbeat: '2026-10-11T19:50:00.000Z' }), now)).toMatchObject({
      label: 'Offline',
      tone: 'crit',
    });
  });

  it('colours log lines and formats the day', () => {
    expect(logLine('21:31:00 loge-app#22: gate ci fejlet')).toEqual({
      time: '21:31',
      text: 'loge-app#22: gate ci fejlet',
      tone: 'warn',
    });
    expect(logLine('21:05:00 x: gate review bestået 8/10').tone).toBe('ok');
    expect(logLine('21:06:00 Fejl: GitHub svarer ikke').tone).toBe('crit');
    expect(logLine('21:07:00 Daemonen starter.').tone).toBe('neutral');
    expect(todayLine({ prs: 4, merged: 2, firstPass: 71 })).toBe(
      "4 PR'er · 2 merged · first-pass 71 %",
    );
    expect(todayLine({ prs: 1, merged: 0, firstPass: null })).toBe('1 PR · 0 merged');
    expect(ago('2026-10-11T19:59:48.000Z', now)).toBe('12 s');
  });

  it('labels projects, queue entries and what waits for the owner', () => {
    const state = sampleState({ focus: 'ekvilibrium' });
    expect(projectMeta('loge-app', state)).toEqual({ text: 'aktiv', tone: 'ok' });
    expect(projectMeta('ekvilibrium', state)).toEqual({ text: 'slukket', tone: 'neutral' });
    const enabled = { ...state, projects: state.projects.map((p) => ({ ...p, enabled: true })) };
    expect(projectMeta('ekvilibrium', enabled)).toEqual({ text: 'fokus', tone: 'accent' });
    expect(queueMeta(state.queue[0] ?? never())).toBe('klar');
    expect(queueMeta(state.queue[2] ?? never())).toBe('på hold · springes over');
    expect(waitingView(state.waitingForYou[0] ?? never())).toMatchObject({
      action: { label: 'Godkend', command: 'approve' },
      canReject: true,
    });
    expect(waitingView(state.waitingForYou[1] ?? never()).action).toEqual({
      label: 'Åbn PR',
      href: 'https://github.com/o/loge-app/pull/30',
    });
  });

  it('picks the next runner and says where the data comes from', () => {
    expect(nextRunner(['codex', 'claude'], 'codex')).toBe('claude');
    expect(nextRunner(['codex'], 'codex')).toBeNull();
    const direct = { mode: 'direct' as const, connected: true, error: null, updatedAt: null };
    expect(sourceLine(direct, null, now)).toEqual({ text: 'Direkte · live', tone: 'ok' });
    expect(sourceLine({ ...direct, mode: 'github' }, sampleState(), now).text).toBe(
      'GitHub · status 12 s gammel',
    );
    expect(
      sourceLine({ ...direct, connected: false, error: 'Daemonens API svarer ikke.' }, null, now)
        .text,
    ).toBe('Direkte · Daemonens API svarer ikke.');
  });
});
