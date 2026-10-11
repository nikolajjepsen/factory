# ai-factory

En lokal AI-fabrik: Nikolaj sætter mål og prioriteter i GitHub, og agenter (primært Codex) analyserer, specificerer, koder, tester, reviewer og dokumenterer.

## Kør fabrikken

### Én gang

1. Installér Node 22 eller nyere, slå pnpm til med `corepack enable`, og kør `pnpm install`.
2. Installér `codex`, og log ind med dit ChatGPT-login: `codex login`.
3. Log ind med `gh auth login`, og giv tokenet adgang til boards: `gh auth refresh -s project`.
4. Installér OrbStack til kontrolrummet.
5. Udfyld `factory.yml` (board, `owner_login`, `status_repo`) og `projects.yml` (projekterne). Hvert projekt skal være klonet på sin `path`.
6. Giv GitHub-boardet de Status-kolonner, `factory.yml` nævner (`Ready`, `In progress`, `In review`, `Done`).

### Start og stop

Kør kommandoerne fra fabrikkens mappe (`~/dev/ai-factory`). En installeret launchd-agent starter selv i den mappe.

```bash
pnpm factory daemon              # i forgrunden; Ctrl-C stopper og gemmer et kørende trin som WIP
pnpm factory install-service     # døgnet rundt som launchd-agent, også efter genstart af Mac'en
tail -f ~/.ai-factory/logs/daemon.log
pnpm factory uninstall-service   # stop launchd-agenten
docker compose up -d dashboard   # kontrolrummet på https://dashboard.ai-factory.orb.local
```

Kontrolrummet genstarter selv med OrbStack. Når daemonen er stoppet, viser det "Offline".

Pause, fokus, tænd/sluk pr. projekt og boost gemmes i `~/.ai-factory/state.db` og gælder også efter en genstart. Tjek dem i kontrolrummet eller med `/factory status`, når du starter fabrikken igen.

### Giv den arbejde

- Læg et issue i "Ready" på boardet. Det øverste kort tages først.
- Labelet `idea` sender issuet gennem produktafdelingen: Decision Brief, spec og sub-issues. `bug` giver `bugfix`. Ellers bruges `feature`. Se `docs/workflows.md`.
- Styr fabrikken med knapperne i kontrolrummet eller med `/factory`-kommentarer, fx `/factory status` på "Factory Status"-issuet. Se `docs/daemon.md`.
- Fabrikken merger aldrig selv. PR'er med `factory:ready-to-merge` merger du.

## Udvikling

Kræver Node 22 eller nyere og pnpm (versionen står i `packageManager` i `package.json`; `corepack enable` henter den).

```bash
pnpm install
pnpm check              # typecheck + lint + test, samme som CI
pnpm factory --version  # kør CLI'en direkte fra kildekoden
pnpm factory quota      # Codex-kvoten (kræver codex installeret og logget ind)
pnpm factory run --project ekvilibrium --issue 1   # kør ét issues workflow til en PR uden daemonen
pnpm factory log --project ekvilibrium --issue 1   # forsøgsloggen: agent-turns og gates
pnpm factory workflow validate                     # tjek workflows, agentfiler og project.yml
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
- `docs/agents.md` – agentfiler, valget af agent og `.factory/project.yml`
- `docs/daemon.md` – daemonen: boardet, projekter, kvote, heartbeat, ChatOps, nødbremse og launchd
- `docs/api.md` – daemonens HTTP-API: tilstand, events og kommandoer
- `projects.yml` – de projekter, fabrikken arbejder på (`repo` og lokal `path`)
- `factory.yml` – fabrikkens konfiguration: board, ejer, status-repo, runner, grænser, kvoteregler og API-port
- `CHANGELOG.md` – ændringer i adfærd
- `daemon/` – kø, tilstandsmaskine, heartbeat, kvote og CLI'en (`daemon/cli/`)
- `runners/` – motor-adaptere (Codex først)
- `packages/protocol/` – zod-skemaer for tilstand, events og kommandoer, delt af daemon og dashboard
- `agents/baseline/` – generalist-agenter pr. rolle
- `dashboard/` – kontrolrummet som container (se `dashboard/README.md`)
- `docker-compose.yml` – compose-projektet `ai-factory` med servicen `dashboard`
- `templates/` – skabeloner til produktafdelingen

## Arkitektur i én linje

Daemonen (motoren) kører native på Mac'en, hvor Codex-loginet bor. Kontrolrummet kører i en container under OrbStack (`https://dashboard.ai-factory.orb.local`) og taler med daemonens API (`direct`) eller kun med GitHub (`github`).
