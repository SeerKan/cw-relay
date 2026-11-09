# Changelog

## 1.3.0 — 2026-11-09

- Consum în Wh pe comandă, cu bază de contor păstrată în jurnal și măsurare invalidată la resetarea contorului sau schimbarea dispozitivului.
- Momente locale pentru finalul detectat și oprirea releului; durata efectivă exclude confirmarea finalului și rămâne corectă la raportarea întârziată.
- Măsurătorile finalizate sunt înghețate și supraviețuiesc restartului; comenzile vechi fără bază de contor nu primesc consum inventat.

## 1.2.0 — 2026-11-09

- Control manual ON/OFF din administrare, fără program sau timer, cu jurnal persistent și confirmarea stării fizice.
- Intervențiile manuale rezervă mașina până la oprirea confirmată și nu pot prelua o sesiune de client.
- Restartul și pierderea conexiunii cloud nu opresc automat o intervenție manuală și nu retrimit pornirea.


## 1.1.1 — 2026-11-09

- Păstrează motivul blocării unei sesiuni în verificare chiar dacă apar ulterior erori de comunicație. Un timeout ulterior nu poate ascunde o pierdere reală a alimentării.


## 1.1.0 — 2026-11-09

- Sesiunile în încărcare/rulare și momentele originale se păstrează la restart/deploy; releul este verificat înainte de reluarea monitorizării, fără retrimiterea pornirii.
- Jurnalul păstrează checkpoint-uri cu identitatea Shelly, uptime și consumul contorizat. Repornirea hardware, pierderea alimentării sau contradicțiile păstrează verificarea operatorului.
- Confirmarea consumului și a finalului se reia din citiri noi; intervalele fără observații nu sunt contabilizate drept oprire confirmată.
- Jurnalele vechi cu pornire cunoscută păstrează cronometrul, dar cer consum activ nou înainte de finalizare automată. Sesiunile deja blocate și pornirile neconfirmate nu sunt rezolvate prin presupuneri.


## 1.0.2 — 2026-11-09

- Sincronizarea cloud așteaptă finalizarea citirii locale în curs, evitând întreruperea telemetriei prin suprapunerea temporizatoarelor.
- Citirile, comenzile și reconcilierea folosesc aceeași excludere mutuală; temporizările locale continuă în timpul operațiilor cloud.

## 1.0.1 — 2026-11-09

- Recuperarea adresei IP pe sesiuni incerte păstrează jurnalul și blocarea de siguranță, fără reactivarea releelor.
- Citirile noi includ adresa, momentul observației și eroarea de comunicație separată de istoricul sesiunii.
- Canalele necalificate pot fi citite pentru diagnostic; controlul rămâne condiționat de calificare și lista locală de dispozitive.

## 1.0.0 — 2026-11-02

- Prima versiune a conectorului CozyWash pentru Home Assistant.
- Configurare RO/EN pentru URL, token, dispozitive/IP-uri și parole Shelly.
- Jurnal persistent, oprire controlată, recuperare după repornire și watchdog independent de conexiunea cloud.
- Container fără dependențe npm, pentru amd64 și aarch64, fără acces privilegiat sau API Home Assistant.
