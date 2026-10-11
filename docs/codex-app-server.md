# Codex app-server

Fabrikken taler med Codex gennem `codex app-server` over stdio. Koden ligger i `runners/codex/`. Formatet nedenfor er målt på `codex-cli 0.162.1`, og de rå svar ligger i `test/fixtures/codex/`.

## Protokol

- Én JSON-besked pr. linje (JSONL) på stdin og stdout. stderr er kun log.
- JSON-RPC 2.0, men uden feltet `"jsonrpc": "2.0"`. Beskederne er `{id, method, params}`, `{id, result}`, `{id, error: {code, message}}` og `{method, params}`.
- Klienten sender `initialize` med `clientInfo` og venter på svaret. Derefter sender den notifikationen `initialized`. Kald før `initialize` giver fejlen `-32600 Not initialized`.
- Serveren sender uopfordrede notifikationer, fx `remoteControl/status/changed` og `account/updated`.
- Serveren kan også sende requests til klienten (godkendelser, værktøjskald). I M1 svarer klienten `-32601` på dem alle, så serveren aldrig venter.
- `codex app-server generate-ts --out <mappe>` genererer de aktuelle protokoltyper. Brug dem, når et nyt kald skal bygges.

## Klienten

`AppServerClient` (`runners/codex/appServerClient.ts`):

- Tilstande: `idle → starting → ready`, ved nedbrud `restarting → ready`, og `stopped`.
- Fejler første start (fx `codex` mangler eller ikke er logget ind), afviser `start()` med fejlen og stderr. Der genstartes ikke.
- Dør processen efter `ready`, afvises igangværende requests med `AppServerExitedError`. Klienten genstarter med eksponentiel backoff (1 s, 2 s, 4 s … højst 60 s) og nulstiller backoff efter en vellykket genstart.
- Requests, der sendes under en genstart, venter på, at processen er klar igen. Alle requests har en timeout (30 s som standard).
- Alle svar valideres med et zod-skema, som kalderen giver med.

## Kvote

`account/rateLimits/read` returnerer bl.a. `rateLimits` og `rateLimitsByLimitId`. Fabrikken bruger bucket'en `codex` og falder tilbage til `rateLimits`.

- Vinduerne findes på varighed: `windowDurationMins` (eller `window_minutes`) 300 er 5-timersvinduet, og 10080 er ugevinduet. Om de ligger i `primary` eller `secondary`, er ligegyldigt.
- Felter accepteres i camelCase og snake_case. `resetsAt` accepteres som unix-sekunder, unix-millisekunder eller ISO 8601.
- `account/rateLimits/updated` er en sparsom opdatering. Den flettes ind i det seneste snapshot: vinduer og nulstillingstider, opdateringen udelader, beholder deres værdi.
- Resultatet er `QuotaSnapshot` (`daemon/quota/quota.ts`) med ISO-tidspunkter. Kernen kender kun `QuotaSource`-interfacet.

## CLI

```bash
pnpm factory quota          # % tilbage og nulstillingstid i lokal tid
pnpm factory quota --json   # normaliseret QuotaSnapshot
pnpm factory quota --raw    # rå svar fra app-serveren, til nye fixtures
```
