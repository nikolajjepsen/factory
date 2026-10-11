# ai-factory

En lokal AI-fabrik: Nikolaj sætter mål og prioriteter i GitHub, og agenter (primært Codex) analyserer, specificerer, koder, tester, reviewer og dokumenterer.

## Kom i gang (bootstrapping)

Fabrikken kan ikke bygge sig selv endnu, så de første milepæle bygges interaktivt:

```bash
cd ~/dev/ai-factory
git init && gh repo create ai-factory --private --source . --push   # valgfrit, men anbefalet
codex
```

Første prompt til Codex (eller Claude Code):

> Læs AGENTS.md og BUILD_PLAN.md. Lav en plan for M0, og byg den, når jeg har godkendt.

Fortsæt milepæl for milepæl. Efter M3 kan fabrikken begynde at tage sine egne issues.

## Udvikling

Kræver Node 22 eller nyere og pnpm (versionen står i `packageManager` i `package.json`; `corepack enable` henter den).

```bash
pnpm install
pnpm check              # typecheck + lint + test, samme som CI
pnpm factory --version  # kør CLI'en direkte fra kildekoden
pnpm factory quota      # Codex-kvoten (kræver codex installeret og logget ind)
pnpm factory run --project ekvilibrium --issue 1   # kør issuets workflow til en PR, der er klar til merge
pnpm factory log --project ekvilibrium --issue 1   # forsøgsloggen: agent-turns og gates
pnpm factory workflow validate                     # tjek workflow-filerne
pnpm factory daemon                                # kør fabrikken i forgrunden
pnpm factory install-service                       # kør den døgnet rundt som launchd-agent
pnpm factory api-token                             # tokenet til daemonens API på 127.0.0.1:4712
pnpm format             # ret formatering med Prettier
```

CLI'en køres med `tsx` direkte fra TypeScript-kilden. Der er intet build-trin.

## Branch protection

CI-workflowet `.github/workflows/ci.yml` har ét job, `pnpm check`. Opsæt branch protection på `main` sådan her (Settings → Branches → Add rule, eller en ruleset):

- Kræv en pull request før merge.
- Kræv, at status-tjekket `pnpm check` er grønt, og at branchen er opdateret med `main`.
- Bloker force push og sletning af `main`.
- Gælder også administratorer. Nikolaj er merge-gate, men går også gennem grøn CI.

Fabrikken ændrer aldrig selv CI-konfiguration eller branch protection. En PR, der rører `.github/`, skal sige det tydeligt i beskrivelsen.

## Filer

- `BUILD_PLAN.md` – milepæle og acceptkriterier
- `AGENTS.md` / `CLAUDE.md` – regler for agenterne
- `docs/design.md` – designdokumentet
- `docs/mockups/` – kontrolrummet
- `docs/codex-app-server.md` – protokollen og klienten mod `codex app-server`
- `docs/runner.md` – runner-kontrakten, og hvordan et issue bliver til en PR
- `docs/workflows.md` – workflow-filer, ordforrådet og motoren
- `docs/daemon.md` – daemonen: boardet, kvote, heartbeat, ChatOps, nødbremse og launchd
- `docs/api.md` – daemonens HTTP-API: tilstand, events og kommandoer
- `projects.yml` – de projekter, fabrikken arbejder på (`repo` og lokal `path`)
- `factory.yml` – fabrikkens konfiguration: board, ejer, status-repo, runner, grænser, kvoteregler og API-port
- `CHANGELOG.md` – ændringer i adfærd
- `daemon/` – kø, tilstandsmaskine, heartbeat, kvote og CLI'en (`daemon/cli/`)
- `runners/` – motor-adaptere (Codex først)
- `packages/protocol/` – zod-skemaer for tilstand, events og kommandoer, delt af daemon og dashboard
- `agents/baseline/` – generalist-agenter pr. rolle
- `dashboard/` – kontrolrummet som container
- `templates/` – skabeloner til produktafdelingen

## Arkitektur i én linje

Daemonen (motoren) kører native på Mac'en, hvor Codex-loginet bor. Kontrolrummet kører i en container under OrbStack (`https://dashboard.ai-factory.orb.local`) og taler med daemonens API (`direct`) eller kun med GitHub (`github`).
