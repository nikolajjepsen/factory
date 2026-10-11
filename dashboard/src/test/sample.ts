import type { FactoryState } from '@ai-factory/protocol';

/** A busy evening in the factory, for rendering and model tests. */
export function sampleState(patch: Partial<FactoryState> = {}): FactoryState {
  return {
    mode: 'running',
    reason: null,
    heartbeat: '2026-10-11T19:59:48.000Z',
    nextStart: null,
    quota: {
      snapshot: {
        fiveHour: { usedPercent: 61, resetsAt: '2026-10-11T20:28:00.000Z' },
        weekly: { usedPercent: 29, resetsAt: '2026-10-18T15:28:00.000Z' },
        fetchedAt: '2026-10-11T19:59:00.000Z',
      },
      pacing: { day: '2026-10-11', budget: 14, usedToday: 6 },
    },
    quotaOverrideUntil: null,
    focus: null,
    projects: [
      { name: 'loge-app', repo: 'o/loge-app', enabled: true },
      { name: 'ekvilibrium', repo: 'o/ekvilibrium', enabled: false },
    ],
    runners: ['codex', 'claude'],
    halted: false,
    current: {
      project: 'loge-app',
      issue: 22,
      title: 'Upload-pipeline: komprimering, thumbnails, EXIF',
      url: 'https://github.com/o/loge-app/issues/22',
      workflow: 'feature',
      stage: 'implement',
      phase: 'code',
      attempt: 2,
      since: '2026-10-11T19:42:00.000Z',
      runner: 'codex',
      steps: [
        { label: 'implement', state: 'active' },
        { label: 'CI', state: 'pending' },
        { label: 'Review', state: 'pending' },
      ],
    },
    queue: [
      {
        project: 'loge-app',
        issue: 23,
        title: 'Datamodel: album og begivenhed',
        url: 'u23',
        held: false,
      },
      {
        project: 'loge-app',
        issue: 24,
        title: 'Galleri-visning',
        url: 'u24',
        held: false,
        skip: 'venter på sub-issues #22, #23',
      },
      {
        project: 'ekvilibrium',
        issue: 9,
        title: 'Tilføj max',
        url: 'u9',
        held: true,
        skip: 'factory:hold',
      },
    ],
    waitingForYou: [
      { project: 'loge-app', issue: 19, kind: 'needs-you', text: 'venter på din godkendelse' },
      {
        project: 'loge-app',
        issue: 21,
        kind: 'ready-to-merge',
        text: 'grøn og reviewet',
        url: 'https://github.com/o/loge-app/pull/30',
      },
    ],
    today: { prs: 4, merged: 2, firstPass: 71 },
    log: [
      '21:05:00 loge-app#21: gate review (reviewer, min 7) bestået 8/10',
      '21:31:00 loge-app#22: gate ci fejlet',
      '21:42:00 loge-app#22: Stage "implement", code, forsøg 2: implementer på codex.',
    ],
    ...patch,
  };
}
