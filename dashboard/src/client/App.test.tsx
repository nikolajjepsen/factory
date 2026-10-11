import type { Command } from '@ai-factory/protocol';
import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { sampleState } from '../test/sample.js';
import { ControlRoom } from './App.js';

const now = new Date(2026, 9, 11, 22, 0, 0);
const source = { mode: 'direct' as const, connected: true, error: null, updatedAt: null };

describe('ControlRoom', () => {
  it('renders the mockup sections from a real state, without emojis', () => {
    const commands: Command[] = [];
    const html = render(
      <ControlRoom
        state={sampleState({ heartbeat: new Date(now.getTime() - 12_000).toISOString() })}
        source={source}
        now={now}
        name="Nikolaj"
        run={(c) => commands.push(c)}
      />,
    );
    for (const text of [
      'God aften, Nikolaj',
      'Kører · hb 12 s',
      'Runner: codex',
      'Nødstop',
      'loge-app#19',
      'Godkend',
      'Åbn PR',
      'ARBEJDER PÅ NU',
      'feature.yml · codex · forsøg 2',
      'Upload-pipeline: komprimering, thumbnails, EXIF',
      'NÆSTE I KØEN',
      'venter på sub-issues #22, #23',
      'Frigiv',
      '// LOG',
      '39% tilbage',
      'dagsbudget 14 % · brugt 6 %',
      'Boost til midnat',
      'Direkte · live',
      'aria-label="Sluk loge-app"',
      'aria-label="Tænd ekvilibrium"',
      'slukket',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/4 PR(&#39;|')er · 2 merged · first-pass 71 %/);
    expect(html).toContain('step step-active');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(commands).toEqual([]);
  });

  it('shows a waiting screen until the first state arrives', () => {
    const html = render(
      <ControlRoom
        state={null}
        source={{ ...source, connected: false, error: 'Daemonens API svarer ikke.' }}
        now={now}
        name={null}
        run={() => undefined}
      />,
    );
    expect(html).toContain('Daemonens API svarer ikke.');
  });
});
