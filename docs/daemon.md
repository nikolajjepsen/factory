# Daemonen

`factory daemon` er fabrikkens motor. Den kører native på Mac'en, henter arbejde fra GitHub-boardet og kører workflows (se `docs/workflows.md`). `factory install-service` installerer den som launchd-agent, så den kører døgnet rundt.

## Et gennemløb (tick)

1. Læs nye `/factory`-kommentarer fra ejeren.
2. Er nødbremsen aktiv, eller er fabrikken sat på pause: gør intet andet.
3. Tjek kørsler, der venter på en `human`-gate.
4. Har en kørsel mere at gøre: tjek kvoten, og kør ét trin (én agent-turn og dens gates).
5. Ellers: find det øverste egnede kort i "Ready", tjek kvoten, flyt kortet til "In progress" og start dets workflow.

Tillader kvoten ikke et nyt trin, går daemonen i `waiting_quota` (se "Kvote").

Når en kørsel er færdig, flyttes kortet til "In review", og PR'en får `factory:ready-to-merge`. Er der intet at lave, venter daemonen et minut.

## Boardet

`factory.yml` peger på boardet (`board.owner`, `board.number`) og oversætter Status-kolonnerne (`ready`, `in_progress`, `review`, `done`). GraphQL-API'et returnerer kortene i boardets manuelle rækkefølge. Den rækkefølge er prioriteten, også på tværs af projekter, og daemonen ændrer den aldrig. Vil du have et projekt frem, flytter du dets kort op.

Et kort i "Ready" springes over, hvis:

- issuet er lukket, eller repoet ikke står i `projects.yml`,
- projektet er slukket (se "Projekter"),
- `focus` er sat til et andet projekt,
- det har labelet `factory:hold` eller `factory:blocked`,
- det har åbne sub-issues eller er "blocked by" et åbent issue,
- fabrikken allerede har en kørsel for det.

Grunden vises i køen i statusissuet.

## Projekter

`projects.yml` lister projekterne med `repo` og `path`. Hvert projekt kan slukkes med `/factory disable <projekt>` eller kontakten i kontrolrummet og tændes igen med `/factory enable <projekt>`. Indstillingen gemmes i daemonens database ligesom pause og fokus, så den overlever genstart.

Et slukket projekt får ingen nye trin:

- dets kort i "Ready" springes over med grunden "<projekt> er slukket",
- dets igangværende kørsler bliver stående og fortsætter, når projektet tændes igen,
- et trin, der kører, når du slukker, gøres færdigt.

Daemonen går videre med kort fra de andre projekter. Statusissuet viser slukkede projekter under "Slukket".

## Tilstande

`running`, `idle`, `paused`, `waiting_quota` og `error`. `offline` er ikke en tilstand, daemonen melder. Læsere udleder den, når heartbeat er over 5 minutter gammel.

## Heartbeat

Hvert minut redigerer daemonen det fastgjorte issue "Factory Status" i `status_repo`. Det oprettes og fastgøres første gang. Brødteksten er en dansk oversigt (tilstand, heartbeat, næste start, kvote, dagens tal, aktuel opgave, kø, venter på dig, seneste log) og hele tilstanden som JSON i en HTML-kommentar, som dashboardets `github`-tilstand (M5b) læser.

## Kvote

Daemonen læser Codex-kvoten (`account/rateLimits/read`) før hvert trin, hvert 5. minut, mens den venter, og ved heartbeat, hvis den seneste læsning er over 5 minutter gammel. Reglerne står i `factory.yml`:

```yaml
quota:
  pause_below_5h: 15%   # vent, når 5-timersvinduet har mindre end dette tilbage
  reserve_for_me: 0%    # den del af ugekvoten, fabrikken aldrig rører
  pacing: even          # even: fordel ugekvoten jævnt over dagene. none: ingen dagsbudget
```

**Pacing (`even`).** Ugekvoten (minus reserven) fordeles jævnt over tiden til ugens nulstilling. Hver dag får sin andel af tiden før midnat i daemonens tidszone:

- En dag, der starter ved midnat, får det, der er tilbage, delt med antal dage til nulstilling. 60 % tilbage og 4 dage giver 15 %.
- En dag, der starter midt i døgnet (første start, eller den dag ugen nulstilles), får kun andelen af sine resterende timer. Søndag kl. 20 med 100 timer til nulstilling giver 4/100 af det, der er tilbage.
- Den sidste dag tæller som en brøkdel, og ender ugen før midnat, må resten bruges.

Budgettet fastsættes, når dagen starter, og gemmes i `settings` (`quota_pacing_day`), så det hverken skrumper i løbet af dagen eller nulstilles ved genstart. Dagens forbrug er ugens `usedPercent` nu minus værdien ved dagens start. Ubrugt budget ruller videre, fordi morgendagens budget regnes ud fra det, der er tilbage.

**Når en grænse nås**, går daemonen i `waiting_quota` med `nextStart`:

| Grænse | `nextStart` |
| --- | --- |
| 5-timersvinduet under `pause_below_5h` | 5-timersvinduets nulstilling |
| Ugekvoten nede på `reserve_for_me` | ugens nulstilling |
| Dagens budget brugt | næste midnat, eller ugens nulstilling, hvis den kommer før |

Gælder flere, bruges den seneste. En agent-turn, der allerede kører, får lov at blive færdig. Statusissuet viser "Venter på kvote", næste start og dagens budget. Kørsler, der venter på en `human`-gate, tjekkes stadig, fordi det ikke bruger kvote.

**Sikkerhedsnet.** Melder Codex "usage limit" midt i en turn (`codexErrorInfo: "usageLimitExceeded"`, eller teksten "usage limit"), gemmes arbejdet som `WIP: … (quota)`, og kørslen står uændret. Forsøget tæller ikke som fejlet, stigen bruges ikke, og trinnet tages om, når kvoten er tilbage. `nextStart` er reglernes starttid. Viser snapshottet endnu ikke grænsen, bruges nulstillingen af et fuldt vindue og ellers 5-timersvinduets nulstilling.

**`/factory boost`** tilsidesætter fabrikkens egne regler (pacing, `pause_below_5h` og `reserve_for_me`) til midnat, eller i en given tid (`/factory boost 3h`, `90m`). Codex' egen grænse gælder stadig: et vindue på 100 % eller en "usage limit"-fejl stopper fabrikken. `/factory boost off` slår reglerne til igen. Forbruget under boost tæller med i dagens forbrug, så resten af ugens dagsbudgetter bliver mindre. Boost gemmes i `settings` og overlever genstart.

`factory run` følger ikke kvotereglerne. Du starter den selv. Melder Codex "usage limit", stopper den med en besked om, at kørslen er gemt.

## ChatOps

Samme kommandoer kan sendes til daemonens API (`POST /commands`, se `docs/api.md`). Begge veje går gennem én handler.

Kun kommentarer fra `owner_login` udføres. De læses fra statusissuets repo og alle projektrepoer. Hver kommando kvitteres med en +1-reaktion. `status` og fejl besvares med en kommentar.

```
/factory pause | resume | status | halt
/factory stop #N            afbryd, gem arbejdet som WIP-commit
/factory retry #N [--runner x]   prøv igen fra bunden af stigen
/factory hold #N            spring over (label factory:hold)
/factory release #N         frigiv et kort på hold
/factory up #N              ryk kortet én plads op i Ready på boardet
/factory focus <projekt>|off
/factory enable <projekt>   tænd et projekt
/factory disable <projekt>  sluk et projekt (ingen nye trin)
/factory workflow #N <navn> brug et andet workflow fra næste start
/factory reject #N "…"      fejlet gate med teksten som feedback
/factory approve #N         godkend en human-gate
/factory boost [3h|90m|off] tilsidesæt kvotereglerne (til midnat uden varighed)
```

`#N` kan skrives som `#12`, `loge-app#12` eller `owner/repo#12`. På et projekts issue kan nummeret udelades, og `enable`/`disable` kan udelade projektet.

Fabrikken kommenterer med ejerens eget gh-login. Derfor får alle dens kommentarer en skjult markør (`<!-- ai-factory -->`), og kommentarer med markøren udføres aldrig. Kun linjer, der starter med `/factory`, læses.

Kommandoer udføres mellem trin. `stop`, `hold` og `halt` læses også hvert 30. sekund, mens et trin kører, og afbryder det.

## Nødbremse

Fabrikken stopper, mens et af disse gælder:

- filen `~/.ai-factory/HALT` findes (`/factory halt` opretter den),
- et åbent issue i et projektrepo har labelet `factory:halt`.

Nødbremsen afbryder også et kørende trin med en WIP-commit. `/factory resume` (eller Genoptag i kontrolrummet) sletter HALT-filen. Et `factory:halt`-label fjerner du selv på issuet.

## launchd

```bash
pnpm factory install-service     # skriver ~/Library/LaunchAgents/dk.ai-factory.daemon.plist og starter den
pnpm factory uninstall-service
tail -f ~/.ai-factory/logs/daemon.log
```

Agenten får den PATH, som shellen havde ved installationen, så den finder `codex`, `gh` og `git`. Installér igen, hvis de flytter. launchd genstarter daemonen, hvis den stopper (`KeepAlive`). `SIGTERM` afbryder et kørende trin med en WIP-commit.
