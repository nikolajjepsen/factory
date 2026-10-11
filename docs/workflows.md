# Workflows

Fabrikkens flow er ikke hårdkodet. Daemonen fortolker workflow-filer med en generisk motor (`daemon/workflow/engine.ts`). Et nyt forløb kræver kun en ny eller ændret YAML-fil.

## Hvor filerne bor

1. `agents/baseline/workflows/<id>.yml` – fabrikkens standarder: `feature`, `bugfix`, `chore` og `idea`.
2. `<projekt>/.factory/workflows/<id>.yml` – projektets egne. En fil med samme id erstatter baseline-filen helt.

Rubrikker slås op på samme måde: først `<projekt>/.factory/rubrics/…`, derefter `agents/baseline/`. Agentfiler vælges ud fra issuets labels, se `docs/agents.md`.

## Hvilket workflow et issue får

1. `/factory workflow #N <navn>` (gemt pr. issue).
2. Label `workflow:<navn>`.
3. Label `idea` giver `idea` (se "Produktafdelingen").
4. Issue-type `feature`, `bug` eller `chore`. Repoer på en personlig konto har ikke issue-typer, så fabrikken læser også labels med de navne. `bug` giver `bugfix`.
5. Ellers `feature`.

## Format

```yaml
description: En ny feature.
stages:
  - id: implement
    agent: implementer
    strategy: direct              # direct | plan_then_code
    output: pr                    # pr | comment | issues
    runner: codex                 # valgfri; se "Runner" i docs/agents.md
    instructions: Ekstra besked til agenten i netop denne stage.
    gates:
      - ci
      - review: { agent: reviewer, rubric: rubrics/code.md, min_score: 7 }
      - human: approve_pr
    on_fail: [retry_with_feedback x3, escalate: human]
```

`pnpm factory workflow validate` tjekker skemaet og at agenter, rubrikker og runnere findes. Den tjekker også projektets agentfiler og `.factory/project.yml`. CI kører den. Fejlbeskederne peger på filen og feltet, fx `→ at stages[0].on_fail[1].switch_strategy`.

## Ordforråd

| Nøgle | Adfærd |
| --- | --- |
| `agent: <navn>` | Rollen. Agent-laget vælger filen ud fra issuets `area:`-labels (se `docs/agents.md`). Agentfilen bliver til prompten sammen med issue, spec, `AGENTS.md`, agentens `context`, projektets `ci`-kommando, stagens `instructions` og al feedback indtil nu. |
| `strategy: direct` | Én turn løser opgaven. |
| `strategy: plan_then_code` | Første turn skriver `PLAN.md`. Gates med `on: plan` kører. Anden turn koder efter planen og sletter `PLAN.md`. |
| gate `ci` | Venter på GitHub-tjek på den pushede commit (højst `ci_timeout_minutes`). Rødt CI giver fejlede tjek og et uddrag af jobloggen som feedback. |
| gate `review: { agent, rubric, min_score, on? }` | En reviewer-agent i skrivebeskyttet sandkasse svarer `{ score, passed, feedback[] }`. Den består, hvis `passed` og `score ≥ min_score`. |
| `output: pr` | Standarden. Agenten skriver på branchen, og fabrikken committer, pusher og åbner en PR. |
| `output: comment` | En skrivebeskyttet turn. Agentens svar kommenteres på issuet. Kræver `strategy: direct`. |
| `output: issues` | En skrivebeskyttet turn, der svarer med en liste af issues. Fabrikken opretter dem som sub-issues af issuet med `area:`-label og "blocked by" og lægger dem i Ready. Issuet får labelet `epic`. Kræver `strategy: direct`. |
| gate `human: always \| approve_pr \| answer \| merge` | Label `factory:needs-you` og en kommentar. Kørslen parkeres, og daemonen arbejder videre med andet. Alle består på `/factory approve #N`. `approve_pr` består også på et godkendende review fra `owner_login`. `answer` består på ejerens første kommentar på issuet, der er mere end `/factory`-kommandoer, og svaret gives videre. `merge` består, når kørslens PR er merget. `approve_pr` og `merge` fejler på et review, der beder om ændringer, med reviewets tekst som feedback. Kun svar efter den seneste turn tæller. |
| `retry_with_feedback xN` | Kør stagen igen med al feedback, højst N gange. |
| `switch_strategy: <s>` | Kør stagen igen med en anden strategi. |
| `switch_runner: <r>` | Kør stagen igen på en anden runner. Findes runneren ikke, springes trinnet over. |
| `switch_agent: <navn>` | Kør stagen igen med en anden agent, fx en specialist. Findes agenten ikke, springes trinnet over. |
| `escalate: human` | Label `factory:blocked`, en kommentar med den seneste feedback, stop. |

`ci`, `approve_pr` og `merge` kræver en PR, så de kun er tilladt på stages med `output: pr`.

`/factory reject #N "…"` tæller som en fejlet gate på den aktuelle stage med teksten som feedback.

## Overlevering mellem stages

`feedback` gælder kun den aktuelle stage. Det, en stage producerer, gives videre til alle senere stages under `# Earlier in this workflow` i prompten: kommentaren fra en `output: comment`-stage, ejerens svar fra `human: answer` og PR'en med opsummering fra en `output: pr`-stage. En PR i et workflow, hvor en senere stage har `output: issues`, skriver `Refs #N` i stedet for `Closes #N`, fordi issuet bliver epic'en.

## Produktafdelingen

Workflowet `idea` gør en løs idé til issues, der er klar til at bygge. Læg et issue med labelet `idea` i Ready, fx "Jeg vil have et galleri".

1. **analysis:** analysten kommenterer en Decision Brief (skabelonen `templates/decision-brief.md`) med højst fem spørgsmål og en anbefaling til hvert. Kørslen venter på dit svar. Svar i en almindelig kommentar, eller skriv `/factory approve #N` for at følge alle anbefalinger.
2. **spec:** spec-agenten skriver `specs/<feature>.md` og eventuelle ADR'er i `docs/adr/` og åbner en PR. Kørslen venter, til du merger den. Et review med "request changes" sender spec'en tilbage med din tekst som feedback.
3. **plan:** planneren læser den mergede spec og svarer med sub-issues. Fabrikken opretter dem, kobler afhængigheder og lægger dem i Ready. Idé-issuet bliver epic'en og bliver stående i "In progress".

Daemonen tager derefter sub-issues fra Ready, når deres afhængigheder er lukket. En plan med ukendte afhængigheder eller dobbelte nøgler sendes tilbage til planneren som feedback. Oprettede issues gemmes på kørslen, så et nyt forsøg ikke opretter dem igen.

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
