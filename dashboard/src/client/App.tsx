import type { Command, FactoryState, QuotaWindow } from '@ai-factory/protocol';
import { useEffect, useState } from 'preact/hooks';
import {
  ago,
  clock,
  greeting,
  logLine,
  modeView,
  nextRunner,
  percent,
  projectMeta,
  queueMeta,
  quotaBar,
  type SourceStatus,
  sourceLine,
  todayLine,
  waitingView,
} from './model.js';
import { loadConfig, sendCommand, useFactory, useNow } from './store.js';

type Run = (command: Command) => void;

/** The live control room: connection, clock and commands around the pure view. */
export function App() {
  const { state, source } = useFactory();
  const now = useNow();
  const [name, setName] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    loadConfig()
      .then((c) => {
        setName(c.name);
      })
      .catch(() => undefined);
  }, []);
  const run: Run = (command) => {
    sendCommand(command)
      .then((result) => {
        setNotice({ text: result.text, error: false });
      })
      .catch((error: unknown) => {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      });
  };
  return (
    <ControlRoom state={state} source={source} now={now} name={name} run={run} notice={notice} />
  );
}

export interface ControlRoomProps {
  state: FactoryState | null;
  source: SourceStatus | null;
  now: Date;
  name: string | null;
  run: Run;
  notice?: { text: string; error: boolean } | null;
}

export function ControlRoom({ state, source, now, name, run, notice }: ControlRoomProps) {
  const [project, setProject] = useState<string | null>(null);
  if (!state) {
    return (
      <div class="shell">
        <div class="loading">
          <Brand />
          <p>{source?.error ?? 'Henter fabrikkens tilstand …'}</p>
          {source && <SourceBadge source={source} state={null} now={now} />}
        </div>
      </div>
    );
  }
  return (
    <div class="shell">
      <nav class="sidebar" aria-label="Projekter">
        <Brand />
        <Projects state={state} selected={project} select={setProject} run={run} />
        <Quota state={state} now={now} run={run} />
        {source && <SourceBadge source={source} state={state} now={now} />}
      </nav>
      <main class="main">
        <Header state={state} now={now} name={name} run={run} />
        <div class="notice" role="status" aria-live="polite">
          {notice && <span class={notice.error ? 'tone-crit' : ''}>{notice.text}</span>}
        </div>
        <Banner state={state} now={now} />
        <Waiting state={state} run={run} />
        <Current state={state} now={now} />
        <div class="row">
          <Queue state={state} project={project} run={run} />
          <Log state={state} />
        </div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <div class="brand">
      <svg
        width="28"
        height="28"
        viewBox="0 0 28 28"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <path d="M19 4a10 10 0 1 0 5 13A8 8 0 0 1 19 4z" />
      </svg>
      <span>Natskift</span>
    </div>
  );
}

function Projects({
  state,
  selected,
  select,
  run,
}: {
  state: FactoryState;
  selected: string | null;
  select: (name: string | null) => void;
  run: Run;
}) {
  const focusTarget = selected ?? state.focus;
  return (
    <div class="projects">
      <span class="label">PROJEKTER</span>
      <button
        type="button"
        class={`project ${selected === null ? 'selected' : ''}`}
        onClick={() => {
          select(null);
        }}
      >
        <span>Alle</span>
        <span class="meta">{state.queue.filter((q) => !q.skip).length || ''}</span>
      </button>
      {state.projects.map((p) => {
        const meta = projectMeta(p.name, state);
        return (
          <div class="project-row" key={p.name}>
            <button
              type="button"
              class={`project ${selected === p.name ? 'selected' : ''} ${p.enabled ? '' : 'off'}`}
              aria-pressed={selected === p.name}
              onClick={() => {
                select(p.name);
              }}
            >
              <span>{p.name}</span>
              <span class={`meta tone-${meta.tone}`}>{meta.text}</span>
            </button>
            <button
              type="button"
              role="switch"
              class="switch"
              aria-checked={p.enabled}
              aria-label={`${p.enabled ? 'Sluk' : 'Tænd'} ${p.name}`}
              title={p.enabled ? `Sluk ${p.name}` : `Tænd ${p.name}`}
              onClick={() => {
                run({ command: p.enabled ? 'disable' : 'enable', project: p.name });
              }}
            >
              <span class="track">
                <span class="knob" />
              </span>
            </button>
          </div>
        );
      })}
      {state.focus ? (
        <button
          type="button"
          class="ghost"
          onClick={() => {
            run({ command: 'focus' });
          }}
        >
          Fjern fokus på {state.focus}
        </button>
      ) : (
        focusTarget && (
          <button
            type="button"
            class="ghost"
            onClick={() => {
              run({ command: 'focus', project: focusTarget });
            }}
          >
            Fokus på {focusTarget}
          </button>
        )
      )}
    </div>
  );
}

function Quota({ state, now, run }: { state: FactoryState; now: Date; run: Run }) {
  const quota = state.quota;
  return (
    <section class="quota terminal" aria-label="Kvote">
      <span class="label">// KVOTE · CODEX</span>
      {quota ? (
        <>
          <Gauge name="5h-vindue" window={quota.snapshot.fiveHour} now={now} />
          <Gauge name="uge" window={quota.snapshot.weekly} now={now} />
          {quota.pacing && (
            <span class="muted small">
              dagsbudget {percent(quota.pacing.budget)} · brugt {percent(quota.pacing.usedToday)}
            </span>
          )}
        </>
      ) : (
        <span class="muted small">Kvoten er ikke læst endnu.</span>
      )}
      {state.quotaOverrideUntil ? (
        <button
          type="button"
          class="dashed"
          onClick={() => {
            run({ command: 'boost', minutes: 0 });
          }}
        >
          Boost til {clock(state.quotaOverrideUntil, now)} · stop
        </button>
      ) : (
        <button
          type="button"
          class="dashed"
          onClick={() => {
            run({ command: 'boost' });
          }}
        >
          Boost til midnat
        </button>
      )}
    </section>
  );
}

function Gauge({ name, window, now }: { name: string; window: QuotaWindow; now: Date }) {
  const bar = quotaBar(window);
  return (
    <div class="gauge">
      <div class="gauge-head">
        <span>{name}</span>
        <span class={`strong tone-${bar.tone}`}>{bar.left}% tilbage</span>
      </div>
      <div class="blocks" role="img" aria-label={`${name}: ${String(bar.left)} procent tilbage`}>
        <span class={`tone-${bar.tone}`}>{bar.filled}</span>
        <span class="empty">{bar.empty}</span>
      </div>
      <span class="muted small">
        {window.resetsAt ? `reset ${clock(window.resetsAt, now)}` : 'reset ukendt'}
      </span>
    </div>
  );
}

function SourceBadge({
  source,
  state,
  now,
}: {
  source: SourceStatus;
  state: FactoryState | null;
  now: Date;
}) {
  const line = sourceLine(source, state, now);
  return (
    <span class={`source tone-${line.tone}`} title="Hvor kontrolrummet henter data fra">
      {line.text}
    </span>
  );
}

function Header({
  state,
  now,
  name,
  run,
}: {
  state: FactoryState;
  now: Date;
  name: string | null;
  run: Run;
}) {
  const mode = modeView(state, now);
  const [confirmHalt, setConfirmHalt] = useState(false);
  useEffect(() => {
    if (!confirmHalt) return;
    const timer = setTimeout(() => {
      setConfirmHalt(false);
    }, 4000);
    return () => {
      clearTimeout(timer);
    };
  }, [confirmHalt]);
  const current = state.current;
  const other = current ? nextRunner(state.runners, current.runner) : null;
  return (
    <header class="header">
      <div class="hello">
        <h1>{greeting(now, name)}</h1>
        <span class="subtitle">{mode.subtitle}</span>
      </div>
      <div class="actions">
        <span class={`pill tone-${mode.tone}`}>
          <span class="dot" />
          {mode.label} · hb {ago(state.heartbeat, now)}
        </span>
        <button
          type="button"
          onClick={() => {
            run({ command: mode.resumes ? 'resume' : 'pause' });
          }}
        >
          {mode.resumes ? 'Genoptag' : 'Pause'}
        </button>
        <button
          type="button"
          disabled={!current || !other}
          title={
            !current ? 'Intet kører' : !other ? 'Der er kun én runner' : `Prøv igen på ${other}`
          }
          onClick={() => {
            if (current && other)
              run({
                command: 'retry',
                issue: current.issue,
                project: current.project,
                runner: other,
              });
          }}
        >
          Runner: {current?.runner ?? state.runners[0] ?? '–'}
        </button>
        <button
          type="button"
          class="danger"
          onClick={() => {
            if (confirmHalt) {
              setConfirmHalt(false);
              run({ command: 'halt' });
            } else {
              setConfirmHalt(true);
            }
          }}
        >
          {confirmHalt ? 'Bekræft nødstop' : 'Nødstop'}
        </button>
      </div>
    </header>
  );
}

function Banner({ state, now }: { state: FactoryState; now: Date }) {
  const banner = modeView(state, now).banner;
  if (!banner) return null;
  return (
    <div class={`banner banner-${banner.tone}`}>
      <strong>{banner.title}</strong>
      <span>{banner.text}</span>
    </div>
  );
}

function Waiting({ state, run }: { state: FactoryState; run: Run }) {
  if (state.waitingForYou.length === 0) {
    return <div class="calm">Intet venter på dig. Fabrikken klarer sig selv.</div>;
  }
  return (
    <section class="waiting" aria-label="Venter på dig">
      {state.waitingForYou.map((entry) => (
        <WaitingCard key={`${entry.project}#${String(entry.issue)}`} entry={entry} run={run} />
      ))}
    </section>
  );
}

function WaitingCard({ entry, run }: { entry: FactoryState['waitingForYou'][number]; run: Run }) {
  const view = waitingView(entry);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const target = { issue: entry.issue, project: entry.project };
  return (
    <div class="attention">
      <span class="icon">{view.icon}</span>
      <div class="grow">
        <span class="strong">{entry.url ? <a href={entry.url}>{view.title}</a> : view.title}</span>
        <span class="small soft">{view.kind}</span>
        {rejecting && (
          <form
            class="reject"
            onSubmit={(e) => {
              e.preventDefault();
              run({ command: 'reject', ...target, feedback });
              setRejecting(false);
              setFeedback('');
            }}
          >
            <label for={`fb-${String(entry.issue)}`}>Feedback til næste forsøg</label>
            <textarea
              id={`fb-${String(entry.issue)}`}
              value={feedback}
              onInput={(e) => {
                setFeedback(e.currentTarget.value);
              }}
              rows={2}
            />
            <button type="submit" class="primary" disabled={feedback.trim() === ''}>
              Send afvisning
            </button>
          </form>
        )}
      </div>
      <div class="buttons">
        {view.canReject && !rejecting && (
          <button
            type="button"
            onClick={() => {
              setRejecting(true);
            }}
          >
            Afvis
          </button>
        )}
        {view.action &&
          ('href' in view.action ? (
            <a class="button primary" href={view.action.href} target="_blank" rel="noreferrer">
              {view.action.label}
            </a>
          ) : (
            <button
              type="button"
              class="primary"
              onClick={() => {
                if (view.action && 'command' in view.action)
                  run({ command: view.action.command, ...target });
              }}
            >
              {view.action.label}
            </button>
          ))}
      </div>
    </div>
  );
}

function Current({ state, now }: { state: FactoryState; now: Date }) {
  const c = state.current;
  return (
    <section class="card current">
      <div class="card-head">
        <span class="label">ARBEJDER PÅ NU</span>
        {c && (
          <span class="label">
            {c.workflow}.yml · {c.runner} · forsøg {c.attempt} · {ago(c.since, now)}
          </span>
        )}
      </div>
      {c ? (
        <>
          <span class="title">
            <a href={c.url}>
              {c.project}#{c.issue}
            </a>{' '}
            {c.title}
          </span>
          {c.steps.length > 0 && (
            <div
              class="steps"
              style={{ gridTemplateColumns: `repeat(${String(c.steps.length)}, minmax(0, 1fr))` }}
            >
              {c.steps.map((step, i) => (
                <div class={`step step-${step.state}`} key={`${String(i)}-${step.label}`}>
                  <div class="bar" />
                  <span>{step.label}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <span class="muted">Intet lige nu.</span>
      )}
    </section>
  );
}

function Queue({ state, project, run }: { state: FactoryState; project: string | null; run: Run }) {
  const entries = state.queue.filter((q) => project === null || q.project === project);
  return (
    <section class="card queue">
      <span class="label">NÆSTE I KØEN</span>
      {entries.length === 0 && <span class="muted">Tom.</span>}
      {entries.map((q, i) => {
        const target = { issue: q.issue, project: q.project };
        return (
          <div class={`queue-row ${q.held ? 'held' : ''}`} key={`${q.project}#${String(q.issue)}`}>
            <span class={`qdot ${q.held ? 'qdot-held' : q.skip ? 'qdot-wait' : 'qdot-ready'}`} />
            <div class="grow">
              <span>
                <a href={q.url}>#{q.issue}</a> {q.title}
              </span>
              <span class="mono small muted">
                {state.projects.length > 1 ? `${q.project} · ` : ''}
                {queueMeta(q)}
              </span>
            </div>
            <div class="buttons">
              <button
                type="button"
                class="icon-button"
                aria-label={`Flyt #${String(q.issue)} op`}
                disabled={i === 0}
                onClick={() => {
                  run({ command: 'up', ...target });
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  aria-hidden="true"
                >
                  <path d="M3 10l5-5 5 5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => {
                  run({ command: q.held ? 'release' : 'hold', ...target });
                }}
              >
                {q.held ? 'Frigiv' : 'Hold'}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Log({ state }: { state: FactoryState }) {
  const lines = [...state.log].reverse().map(logLine);
  return (
    <section class="log terminal" aria-label="Log">
      <div class="card-head">
        <span class="label">// LOG</span>
        <span class="small dim">{todayLine(state.today)}</span>
      </div>
      <div class="log-lines">
        {lines.map((l, i) => (
          <div class="log-line" key={`${String(i)}-${l.time}`}>
            <span class="dim">{l.time}</span>
            <span class={`tone-${l.tone}`}>{l.text}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
