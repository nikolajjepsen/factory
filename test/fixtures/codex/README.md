# Codex app-server-fixtures

Rå svar fra en rigtig `codex app-server`, optaget 2026-10-11 med `codex-cli 0.162.1` på et ChatGPT Plus-login.

| Fil | Indhold |
| --- | --- |
| `app-server-transcript.jsonl` | Serverens stdout-linjer i rækkefølge: svar på `initialize`, en uopfordret notifikation, svar på `account/rateLimits/read` og notifikationen `account/updated`. |
| `rate-limits-read.json` | `result` fra `account/rateLimits/read`, pænt formateret. |
| `app-server-errors.jsonl` | Fejlsvar: kald før `initialize`, ukendt metode (svaret er forkortet af serveren selv) og `initialize` to gange. |

## Anonymisering

Repoet er offentligt. Disse felter er erstattet med pladsholdere, og alt andet er uændret, også tal og tidspunkter:

- `accountId`, `installationId`, `serverName`
- id'erne på `rateLimitResetCredits.credits[]`
- `userAgent` (terminalnavn fjernet) og `codexHome`

## Optag igen

Efter en Codex-opgradering:

```bash
pnpm factory quota --raw > /tmp/rate-limits-read.json
```

Anonymisér felterne ovenfor, og erstat `rate-limits-read.json`. Kør derefter `pnpm check`. `codex app-server generate-ts --out <mappe>` viser de aktuelle protokoltyper.
