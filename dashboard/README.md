# Kontrolrummet

`dashboard/` er kontrolrummet: en tynd klient uden egen tilstand, som viser fabrikken og sender kommandoer. Det kører i en container under OrbStack på `https://dashboard.ai-factory.orb.local`. Udseende og adfærd følger `docs/mockups/` (tema "Natskift", kun dark mode).

```bash
docker compose up -d dashboard          # bygger og starter (direct-tilstand mod en native daemon)
docker compose logs -f dashboard
docker compose --profile docker-desktop up -d dashboard-desktop   # Docker Desktop: http://127.0.0.1:4711
```

## Opbygning

- **Serveren** (`src/server/`, Hono) er det eneste, browseren taler med. Den normaliserer begge kilder til ét API: `GET /api/events` (SSE), `GET /api/state`, `POST /api/commands`, `GET /api/config` og `GET /healthz`. Tokens bliver i containeren.
- **Browser-UI'en** (`src/client/`, Preact) følger `/api/events` og sender knappernes kommandoer til `/api/commands`. Visningslogikken ligger i `model.ts` og er testet uden browser.
- `pnpm --filter @ai-factory/dashboard build` bundler begge med esbuild til `dist/` (`server.mjs` og `public/`). Imaget indeholder kun `dist/` og kører som brugeren `node`.

## To tilstande

`FACTORY_MODE` vælger kilden. Kontrolrummet viser nederst i venstre side, hvilken tilstand det kører i, og hvor gammel den viste status er.

| | `direct` (standard) | `github` |
| --- | --- | --- |
| Kilde | Daemonens API (`docs/api.md`) | Det fastgjorte "Factory Status"-issue |
| Live | Ja, via SSE | Nej. Issuet læses hvert 30. sekund |
| Kommandoer | `POST /commands` på daemonen | `/factory`-kommentarer på statusissuet |
| Kræver | `FACTORY_API_URL` og token | `GITHUB_TOKEN` og `FACTORY_STATUS_REPO` |

I `github`-tilstand kan der gå op til et par minutter, før en kommando ses i kontrolrummet: daemonen læser kommentarer én gang pr. gennemløb (hvert minut, når den er ledig), statusissuet opdateres ved hvert heartbeat (hvert minut), og kontrolrummet læser issuet hvert 30. sekund. `GITHUB_TOKEN` skal tilhøre fabrikkens ejer, fordi daemonen kun udfører ejerens kommentarer. `github`-tilstand behøver ingen adgang til daemonen og kan køre hvor som helst (NAS, sky).

## Miljøvariabler

| Variabel | Standard | Betydning |
| --- | --- | --- |
| `FACTORY_MODE` | `direct` | `direct` eller `github` |
| `FACTORY_API_URL` | `http://host.orb.internal:4712` | Daemonens API set fra containeren |
| `FACTORY_API_TOKEN` / `FACTORY_API_TOKEN_FILE` | – | Tokenet, eller en fil med det. Compose monterer `~/.ai-factory/api-token` som secret |
| `GITHUB_TOKEN`, `FACTORY_STATUS_REPO` | – | Til `github`-tilstand |
| `GITHUB_POLL_SECONDS` | `30` | Hvor ofte statusissuet læses |
| `DASHBOARD_NAME` | – | Navnet i hilsenen ("God aften, Nikolaj") |
| `PORT`, `HOST` | `80`, `0.0.0.0` | Hvor serveren lytter i containeren |

I `github`-tilstand uden en daemon på samme maskine sættes `FACTORY_API_TOKEN_PATH=/dev/null`, så compose ikke leder efter tokenfilen.

## Netværk og sikkerhed

- **Containeren når daemonen på værtens `127.0.0.1`.** OrbStack sender `host.orb.internal` (og `host.docker.internal`) videre til værtens localhost. Det er verificeret med en server bundet til `127.0.0.1`. Daemonen binder derfor kun til `127.0.0.1` og aldrig til containernetværket.
- Compose publicerer ingen porte under OrbStack; domænet er nok, og OrbStack sørger for HTTPS. Profilen `docker-desktop` publicerer kun på `127.0.0.1:4711`.
- Kontrolrummet har intet login, fordi det kun kan nås fra Mac'en. Kommandoer skal være JSON fra kontrolrummets egen origin, så andre websider i browseren ikke kan sende dem.
- Port 80 som non-root kræver `net.ipv4.ip_unprivileged_port_start=0`, som compose sætter.

## Knapper og kommandoer

Alle knapper sender samme kommando som ChatOps (`docs/daemon.md`):

| Knap | Kommando |
| --- | --- |
| Pause / Genoptag | `pause` / `resume` (Genoptag efter Nødstop sletter også `~/.ai-factory/HALT`) |
| Nødstop (to klik) | `halt` |
| Runner | `retry #N --runner <næste>` (deaktiveret med kun én runner) |
| Godkend / Afvis | `approve #N` / `reject #N "…"` |
| Prøv igen | `retry #N` |
| Pil op i køen | `up #N` (flytter kortet én plads op i Ready på boardet) |
| Hold / Frigiv | `hold #N` / `release #N` |
| Fokus | `focus <projekt>` / `focus off` |
| Kontakt ved projektet | `enable <projekt>` / `disable <projekt>` |
| Boost til midnat | `boost` / `boost off` |

"Klar til merge" linker til PR'en. Merge sker på GitHub.
