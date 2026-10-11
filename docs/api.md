# Daemonens API

Daemonen har et lille HTTP-API, som kontrolrummet (M5b) og `curl` taler med. Det startes af `factory daemon` (ikke `--once`) og stoppes sammen med daemonen.

- Det lytter **kun på `127.0.0.1`**. Porten er `api.port` i `factory.yml` (standard 4712).
- Alle kald kræver `Authorization: Bearer <token>`. Uden gyldigt token svarer det `401`.
- Tokenet ligger i `~/.ai-factory/api-token` med rettighederne `0600`. Det oprettes første gang med 256 tilfældige bits. `factory api-token` viser det. En eksisterende fil strammes til `0600`.
- Tokenet sammenlignes i konstant tid (Honos `bearerAuth`).

## Ruter

| Rute | Svar |
| --- | --- |
| `GET /state` | Hele tilstanden (`FactoryState`) |
| `GET /events` | Server-sent events, se nedenfor |
| `POST /commands` | Udfører en kommando og svarer `{ "text": "…", "reply": bool }`. Ugyldig JSON eller kommando giver `400` |

`POST /commands` tager samme kommandoer som ChatOps, fx `{"command":"pause"}`, `{"command":"retry","issue":12,"project":"loge-app","runner":"claude"}` eller `{"command":"boost","minutes":180}`. De går gennem **samme handler** som `/factory`-kommentarer (`Daemon.execute`), logges på samme måde og vækker daemonen, så den reagerer med det samme.

## Tilstanden

Skemaerne bor i `packages/protocol` (`@ai-factory/protocol`), som daemonen og dashboardet deler. `FactoryState` har:

- `mode` (`running | idle | paused | waiting_quota | error`), `reason` (dansk eller `null`), `heartbeat`, `nextStart`
- `quota` (snapshot og dagens pacing-budget) og `quotaOverrideUntil` (aktiv `/factory boost`)
- `focus`, `current` (opgave, workflow, stage, fase, forsøg), `queue`, `waitingForYou`
- `today`: PR'er åbnet i dag, hvor mange af dem der er merged, og first-pass (andelen af dagens færdige stages, der bestod i første forsøg)
- `log`: de seneste 50 linjer

Kvoten læses igen efter hvert trin, og Codex' push-opdateringer (`account/rateLimits/updated`) flettes ind løbende. "Merged" slås op på GitHub ved hvert heartbeat, kun for dagens PR'er og kun til de er merged.

## Events

`GET /events` er en `text/event-stream`:

1. Ved forbindelse: én `state`-hændelse med hele tilstanden uden `log`, og én `log`-hændelse med de seneste linjer.
2. Derefter: `state`-hændelser med **kun de felter, der har ændret sig** (samlet over 50 ms), og en `log`-hændelse for hver ny linje.
3. Hvert 25. sekund en kommentarlinje (`: ping`), så forbindelsen holdes åben.

En klient fletter hver `state`-hændelse ind i det, den har. Alle felter er altid til stede i tilstanden, også når de er `null`, så et felt, der ryddes, sendes som `null`.

```
event: state
data: {"mode":"paused","reason":"Sat på pause med /factory pause."}

event: log
data: {"lines":["20:27:24 Kommando /factory pause: Fabrikken holder pause."]}
```

## Eksempel

```bash
T=$(pnpm -s factory api-token)
curl -H "Authorization: Bearer $T" http://127.0.0.1:4712/state
curl -N -H "Authorization: Bearer $T" http://127.0.0.1:4712/events
curl -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"command":"pause"}' http://127.0.0.1:4712/commands
```

Kontrolrummets container når API'et via `host.orb.internal`, fordi OrbStack sender det videre til værtens `127.0.0.1` (se `dashboard/README.md`). API'et binder derfor aldrig til Docker-netværket.
