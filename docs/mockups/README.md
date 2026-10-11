# Kontrolrums-mockup

`kontrolrum.dc.html` er kilden til den klikbare mockup af kontrolrummet. Den er lavet i et designværktøj og kræver dets runtime, så den åbner ikke direkte i en browser. Brug den som **spec**:

- Markup og inline styles = layout, farver og typografi (IBM Plex Sans/Mono, varm grå baggrund `#F1EFEA`, mørk tekst `#1B1D1F`, signal-amber `#C46A12`).
- Klassen `Component` nederst = adfærd: tilstande (`running`, `paused`, `halted`, `waiting_quota`), knappernes effekt, kø-omprioritering, hold, "venter på dig" og log.
- Al data i mockuppen er eksempeldata.

Den interaktive version ligger privat hos Nikolaj som artifact "Fabrikkens kontrolrum".
