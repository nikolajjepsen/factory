# Kontrolrums-mockup

`kontrolrum.dc.html` er kilden til den klikbare mockup af kontrolrummet. Den er lavet i et designværktøj og kræver dets runtime, så den åbner ikke direkte i en browser. Brug den som **spec**:

- Markup og inline styles = layout, farver og typografi.
- Klassen `Component` nederst = adfærd: tilstande (`running`, `paused`, `halted`, `waiting_quota`), knappernes effekt, projektvalg, kø-omprioritering, hold, "venter på dig" og log.
- Al data i mockuppen er eksempeldata.

## Tema: "Natskift" (kun dark mode)

Der laves **ingen light mode**.

| Token | Værdi | Brug |
| --- | --- | --- |
| `bg` | `#0A0E1A` | Side |
| `panel` | `#10162A` | Kort |
| `panel-deep` | `#070A14` | Kvote og log (terminal-flader) |
| `border` | `#1E2742` | Kortkanter |
| `text` | `#E4E8F5` | Brødtekst |
| `muted` | `#8E99BC` | Labels, metadata |
| `accent` | `#9DB7FF` | Primærknap, aktivt trin |
| `ok` | `#7FE3D0` | Kører, klar, godkendt |
| `warn` | `#F5B971` | Pause, venter, kvote < 50 % |
| `crit` | `#F28B8B` | Nødstop, kvote < 15 % |
| `attention-bg` | `#1A1830` / kant `#3A3466` | "Venter på dig" |

- Skrifttyper: **Sora** (UI, overskrifter) og **JetBrains Mono** (tal, labels, kvote, log).
- Layout: venstre sidebar med projekter og kvote, hovedområde med hilsen og status, "venter på dig" øverst, aktiv opgave, kø og log.
- Kvoten vises som 20 █-blokke pr. vindue (som Codex' `/status`) og farves efter det, der er tilbage.
- Loggen er en terminalflade med farvekodede linjer: neutral, warn, ok, crit.
- Radius 10–16 px, ingen skygger, ingen gradienter ud over trin-fremdriften.

Den interaktive version ligger privat hos Nikolaj som artifact "Fabrikkens kontrolrum".
