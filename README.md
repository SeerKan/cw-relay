# CozyWash Home Assistant add-ons

Conectorul local CozyWash pentru Shelly, instalabil pe mini PC-ul care rulează Home Assistant OS sau o instalare cu Supervisor. Home Assistant Container/Core fără Supervisor nu poate instala add-on-uri; pentru acesta folosește bridge-ul Docker separat.

[![Adaugă repository în Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FSeerKan%2Fcozywash-home-assistant)

1. Deschide linkul de mai sus și confirmă adăugarea repository-ului.
2. Instalează **CozyWash Shelly Connector** din Store.
3. Completează tokenul locației și dispozitivele în fila **Configuration**.
4. Pornește add-on-ul. Activează **Start on boot** și **Watchdog**.

Interfața Home Assistant poate afișa „Apps” în loc de „Add-ons”, în funcție de versiune. Repository-ul poate fi adăugat și manual din Store → meniul ⋮ → Repositories: `https://github.com/SeerKan/cozywash-home-assistant`.

[Configurare și conectarea primei locații](cozywash_bridge/DOCS.md).

Codul acestui repository include numai conectorul. Nu include aplicația web, baza de date a serviciului, tokenuri sau parole. Conectorul nu are nevoie de acces la API-ul Home Assistant, de modul privilegiat, de host networking ori de porturi expuse pe mini PC. Imaginea este construită local de Supervisor folosind Node.js 24; nu sunt instalate pachete npm.
