# CozyWash Shelly Connector

Leagă locația CozyWash de dispozitivele Shelly din aceeași rețea locală. Comunică direct cu API-ul RPC Shelly prin IP fix și cu CozyWash prin HTTPS. Folosește același bridge ca instalarea Docker.

- Configurare din Home Assistant, cu token și parole mascate.
- Jurnal persistent în `/data/bridge`; comenzile nu sunt executate din nou la relivrare.
- Temporizările locale continuă când conexiunea cu serviciul CozyWash cade.
- Repornirea păstrează jurnalul și marchează operațiunile fizice active ca necesitând verificare.
- Control fizic dezactivat implicit, cu listă explicită de IP-uri private și verificarea mașinii din CozyWash.
- Nu folosește integrarea Shelly din Home Assistant, nu cere token Home Assistant și nu deschide porturi publice.

[Instrucțiuni](DOCS.md).
