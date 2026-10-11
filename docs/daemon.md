# Daemonen

`factory daemon` er fabrikkens motor. Den kører native på Mac'en, henter arbejde fra GitHub-boardet og kører workflows (se `docs/workflows.md`). `factory install-service` installerer den som launchd-agent, så den kører døgnet rundt.

## Et gennemløb (tick)

1. Læs nye `/factory`-kommentarer fra ejeren.
2. Er nødbremsen aktiv, eller er fabrikken sat på pause: gør intet andet.
3. Tjek kørsler, der venter på en `human`-gate.
4. Har en kørsel mere at gøre: kør ét trin (én agent-turn og dens gates).
5. Ellers: tag det øverste egnede kort i "Ready", flyt det til "In progress" og start dets workflow.

Når en kørsel er færdig, flyttes kortet til "In review", og PR'en får `factory:ready-to-merge`. Er der intet at lave, venter daemonen et minut.

## Boardet

`factory.yml` peger på boardet (`board.owner`, `board.number`) og oversætter Status-kolonnerne (`ready`, `in_progress`, `review`, `done`). GraphQL-API'et returnerer kortene i boardets manuelle rækkefølge. Den rækkefølge er prioriteten, og daemonen ændrer den aldrig.

Et kort i "Ready" springes over, hvis:

- issuet er lukket, eller repoet ikke står i `projects.yml`,
- `focus` er sat til et andet projekt,
- det har labelet `factory:hold` eller `factory:blocked`,
- det har åbne sub-issues eller er "blocked by" et åbent issue,
- fabrikken allerede har en kørsel for det.

Grunden vises i køen i statusissuet.

## Tilstande

`running`, `idle`, `paused`, `waiting_quota` (M4) og `error`. `offline` er ikke en tilstand, daemonen melder. Læsere udleder den, når heartbeat er over 5 minutter gammel.

## Heartbeat

Hvert minut redigerer daemonen det fastgjorte issue "Factory Status" i `status_repo`. Det oprettes og fastgøres første gang. Brødteksten er en dansk oversigt (tilstand, heartbeat, aktuel opgave, kø, venter på dig, seneste log) og hele tilstanden som JSON i en HTML-kommentar, som dashboardets `github`-tilstand (M5b) læser.

## ChatOps

Kun kommentarer fra `owner_login` udføres. De læses fra statusissuets repo og alle projektrepoer. Hver kommando kvitteres med en +1-reaktion. `status` og fejl besvares med en kommentar.

```
/factory pause | resume | status | halt
/factory stop #N            afbryd, gem arbejdet som WIP-commit
/factory retry #N [--runner x]   prøv igen fra bunden af stigen
/factory hold #N            spring over (label factory:hold)
/factory focus <projekt>|off
/factory workflow #N <navn> brug et andet workflow fra næste start
/factory reject #N "…"      fejlet gate med teksten som feedback
/factory approve #N         godkend en human-gate
```

`#N` kan skrives som `#12`, `loge-app#12` eller `owner/repo#12`. På et projekts issue kan nummeret udelades.

Fabrikken kommenterer med ejerens eget gh-login. Derfor får alle dens kommentarer en skjult markør (`<!-- ai-factory -->`), og kommentarer med markøren udføres aldrig. Kun linjer, der starter med `/factory`, læses.

Kommandoer udføres mellem trin. `stop`, `hold` og `halt` læses også hvert 30. sekund, mens et trin kører, og afbryder det.

## Nødbremse

Fabrikken stopper, mens et af disse gælder:

- filen `~/.ai-factory/HALT` findes (`/factory halt` opretter den),
- et åbent issue i et projektrepo har labelet `factory:halt`.

Nødbremsen afbryder også et kørende trin med en WIP-commit. Fjern filen eller labelet, og skriv `/factory resume`.

## launchd

```bash
pnpm factory install-service     # skriver ~/Library/LaunchAgents/dk.ai-factory.daemon.plist og starter den
pnpm factory uninstall-service
tail -f ~/.ai-factory/logs/daemon.log
```

Agenten får den PATH, som shellen havde ved installationen, så den finder `codex`, `gh` og `git`. Installér igen, hvis de flytter. launchd genstarter daemonen, hvis den stopper (`KeepAlive`). `SIGTERM` afbryder et kørende trin med en WIP-commit.
