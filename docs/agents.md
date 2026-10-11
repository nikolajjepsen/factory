# Agenter og projektindstillinger

En agent er en markdown-fil med YAML-frontmatter. Teksten bliver til agentens prompt sammen med issuet, specen, projektets `AGENTS.md` og feedback. Workflow-filerne (se `docs/workflows.md`) siger, hvilken rolle en stage bruger, fx `agent: implementer`. Agent-laget afgør, hvilken fil der udfylder rollen for det konkrete issue.

## Hvor filerne bor

- `agents/baseline/<rolle>.md` er fabrikkens generalister.
- `<projekt>/.factory/agents/<navn>.md` er projektets egne agenter og domæneagenter.

## Frontmatter

```markdown
---
extends: implementer          # valgfri: en anden agent, hvis tekst kommer først
scope:
  labels: [area:frontend]     # valgfri: gør filen til en domæneagent
context: [docs/ui.md]         # valgfri: projektfiler, der kommer med i prompten
templates: [spec]             # valgfri: skabeloner fra templates/
runner: codex                 # valgfri: runneren for denne agent
---

# Frontend

Brug designsystemet i src/ui. Hver komponent skal have en story.
```

| Felt | Betydning |
| --- | --- |
| `extends` | Agenten arver forælderens tekst, og dens egen tekst lægges efter. `context` lægges sammen, og den nærmeste `runner` vinder. En projektfil, der extender sit eget navn (fx `implementer.md` med `extends: implementer`), arver fra baseline-filen. Cirkler er en fejl. |
| `scope.labels` | Filen er en domæneagent for sin rolle. Den vælges, når issuet har mindst ét af labelsene. |
| `context` | Stier relativt til projektets rod. De læses fra worktree'et og kommer med i prompten under `# Context (<sti>)`. En fil, der mangler, noteres i loggen og springes over. Stier uden for projektet afvises. |
| `templates` | Skabeloner, der kommer med i prompten under `# Template: <navn>`. De slås op i `<projekt>/.factory/templates/<navn>.md` og derefter i fabrikkens `templates/<navn>.md`. |
| `runner` | Runneren for denne agent (se "Runner" nedenfor). |

Ukendte felter er en fejl, så en tastefejl ikke passerer stille. `factory workflow validate` tjekker alle projektets agentfiler.

En agents **rolle** er roden af dens `extends`-kæde. `frontend.md` med `extends: implementer` har rollen `implementer`.

## Hvilken agent der vælges

For en stage med `agent: implementer` på et issue:

1. **Domæneagent.** Blandt projektets agentfiler med `scope.labels` og rollen `implementer` vinder den, der matcher flest af issuets labels. Ved lighed vinder det første navn alfabetisk.
2. **Projektagent.** Ellers `<projekt>/.factory/agents/implementer.md`, hvis den findes.
3. **Baseline.** Ellers `agents/baseline/implementer.md`.

Review-gates vælger reviewer på samme måde. En `ui-reviewer.md` med `extends: reviewer` og `scope.labels: [area:frontend]` reviewer frontend-issues.

Loggen viser valget og grunden, fx `Stage "implement", code, forsøg 1: frontend (label area:frontend) på codex.` Forsøgsloggen i SQLite gemmer agentens navn, så M7b kan se, hvilke agenter der klarer sig godt.

## `.factory/project.yml`

```yaml
# Projektets tjek. Agenten skal køre kommandoen og have den grøn, før den er færdig.
ci: pnpm check

# Runner pr. rolle.
runners:
  reviewer: codex
```

Begge felter er valgfrie. Ukendte felter er en fejl. Antallet af forsøg styres kun i workflow-filerne (`retry_with_feedback xN`).

## Runner

Når flere steder vælger runner, vinder det mest specifikke:

1. `/factory retry #N --runner x` eller trinnet `switch_runner` på stigen.
2. Stagens `runner` i workflow-filen.
3. Agentfilens `runner` (den nærmeste i `extends`-kæden).
4. `runners.<rolle>` i `.factory/project.yml`.
5. `default_runner` i `factory.yml`.

En review-gate følger samme rækkefølge for sin reviewer. Stagens `runner` gælder for revieweren efter `project.yml`.
