# Workflows

Fabrikkens flow er ikke hårdkodet. Daemonen fortolker workflow-filer med en generisk motor (`daemon/workflow/engine.ts`). Et nyt forløb kræver kun en ny eller ændret YAML-fil.

## Hvor filerne bor

1. `agents/baseline/workflows/<id>.yml` – fabrikkens standarder: `feature`, `bugfix` og `chore`.
2. `<projekt>/.factory/workflows/<id>.yml` – projektets egne. En fil med samme id erstatter baseline-filen helt.

Agentfiler og rubrikker slås op på samme måde: først `<projekt>/.factory/agents/<navn>.md` og `<projekt>/.factory/rubrics/…`, derefter `agents/baseline/`.

## Hvilket workflow et issue får

1. `/factory workflow #N <navn>` (gemt pr. issue).
2. Label `workflow:<navn>`.
3. Issue-type `feature`, `bug` eller `chore`. Repoer på en personlig konto har ikke issue-typer, så fabrikken læser også labels med de navne. `bug` giver `bugfix`.
4. Ellers `feature`.

## Format

```yaml
description: En ny feature.
stages:
  - id: implement
    agent: implementer
    strategy: direct              # direct | plan_then_code
    runner: codex                 # valgfri; ellers default_runner fra factory.yml
    instructions: Ekstra besked til agenten i netop denne stage.
    gates:
      - ci
      - review: { agent: reviewer, rubric: rubrics/code.md, min_score: 7 }
      - human: approve_pr
    on_fail: [retry_with_feedback x3, escalate: human]
```

`pnpm factory workflow validate` tjekker skemaet og at agenter, rubrikker og runnere findes. CI kører den. Fejlbeskederne peger på filen og feltet, fx `→ at stages[0].on_fail[1].switch_strategy`.

## Ordforråd

| Nøgle | Adfærd |
| --- | --- |
| `agent: <navn>` | Agentfilen bliver til prompten sammen med issue, spec, `AGENTS.md`, stagens `instructions` og al feedback indtil nu. |
| `strategy: direct` | Én turn løser opgaven. |
| `strategy: plan_then_code` | Første turn skriver `PLAN.md`. Gates med `on: plan` kører. Anden turn koder efter planen og sletter `PLAN.md`. |
| gate `ci` | Venter på GitHub-tjek på den pushede commit (højst `ci_timeout_minutes`). Rødt CI giver fejlede tjek og et uddrag af jobloggen som feedback. |
| gate `review: { agent, rubric, min_score, on? }` | En reviewer-agent i skrivebeskyttet sandkasse svarer `{ score, passed, feedback[] }`. Den består, hvis `passed` og `score ≥ min_score`. |
| gate `human: always \| approve_pr` | Label `factory:needs-you` og en kommentar. Kørslen parkeres, og daemonen arbejder videre med andet. `always` består på `/factory approve #N`. `approve_pr` består også på et godkendende review fra `owner_login`. |
| `retry_with_feedback xN` | Kør stagen igen med al feedback, højst N gange. |
| `switch_strategy: <s>` | Kør stagen igen med en anden strategi. |
| `switch_runner: <r>` | Kør stagen igen på en anden runner. Findes runneren ikke, springes trinnet over. |
| `switch_agent: <navn>` | Kør stagen igen med en anden agent, fx en specialist. Findes agenten ikke, springes trinnet over. |
| `escalate: human` | Label `factory:blocked`, en kommentar med den seneste feedback, stop. |

`/factory reject #N "…"` tæller som en fejlet gate på den aktuelle stage med teksten som feedback.

## Motoren

For hver stage: kør agenten, kør gates i rækkefølge, og lad den første fejlede gate tage næste trin på stigen. Er stigen tom, bliver issuet `factory:blocked`. Når alle stages er godkendt, får PR'en `factory:ready-to-merge`.

Hvert kald til `advance()` kører højst én agent-turn og dens gates. Tilstanden gemmes i `~/.ai-factory/state.db` efter hvert trin, så en kørsel overlever genstarter, og daemonen kan læse kommandoer mellem trinene. En kørsel er `active`, `waiting` (human-gate), `stopped` (afbrudt, kan genoptages), `done` eller `blocked`.

## Forsøgsloggen

Hver agent-turn og hver gate gemmes i tabellen `attempts`: `run_id, project, issue, stage, attempt, phase, agent, runner, strategy, gate, score, passed, feedback, tokens, duration_ms`. Det er datagrundlaget for M7b.

```bash
pnpm factory run --project ekvilibrium --issue 6               # kør issuets workflow
pnpm factory run --project ekvilibrium --issue 6 --workflow chore
pnpm factory log --project ekvilibrium --issue 6               # vis forsøgsloggen
pnpm factory workflow validate
```
