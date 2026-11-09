# Changelog

## 1.0.1 — 2026-11-09

- Recuperarea adresei IP pe sesiuni incerte păstrează jurnalul și blocarea de siguranță, fără reactivarea releelor.
- Citirile noi includ adresa, momentul observației și eroarea de comunicație separată de istoricul sesiunii.
- Canalele necalificate pot fi citite pentru diagnostic; controlul rămâne condiționat de calificare și lista locală de dispozitive.

## 1.0.0 — 2026-11-02

- Prima versiune a conectorului CozyWash pentru Home Assistant.
- Configurare RO/EN pentru URL, token, dispozitive/IP-uri și parole Shelly.
- Jurnal persistent, oprire controlată, recuperare după repornire și watchdog independent de conexiunea cloud.
- Container fără dependențe npm, pentru amd64 și aarch64, fără acces privilegiat sau API Home Assistant.
