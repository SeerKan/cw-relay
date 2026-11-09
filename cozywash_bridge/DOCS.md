# Instalare și configurare

## Instalare

Necesită Home Assistant OS sau o instalare cu Supervisor. Add-on-ul suportă mini PC-uri x86-64 (`amd64`) și sisteme ARM64 (`aarch64`). Adaugă repository-ul `https://github.com/SeerKan/cw-relay` în Store, apoi instalează **CozyWash Shelly Connector**. Construirea imaginii se face pe mini PC; este necesar acces la internet pentru descărcarea imaginii de bază.

## Prima locație

1. În `https://cozywash.ro`, intră cu contul obișnuit de administrator și configurează locația, dispozitivele, mașinile și canalele. Copiază ID-ul fiecărui dispozitiv din **Administrare → Dispozitive**. Un Shelly cu mai multe canale apare o singură dată în configurația add-on-ului; mașinile folosesc canalele configurate în CozyWash.
2. Rezervă IP-uri fixe în router pentru Shelly. Home Assistant trebuie să poată accesa acele IP-uri pe TCP 80. Nu sunt necesare Shelly Cloud, token Home Assistant sau integrarea Shelly din Home Assistant. Conectorul folosește RPC `Switch.GetStatus`/`Switch.Set` cu măsurare de putere și autentificare Digest SHA-256; dispozitivele Gen1 și dispozitivele fără `apower` nu sunt compatibile cu această versiune.
3. Din **Administrare → Bridge local**, emite tokenul pentru locație și copiază-l în `bridge_token` în fila Configuration a add-on-ului. Emiterea unui token nou îl revocă pe cel anterior. Nu emite tokenul final până nu ești pregătit să înlocuiești bridge-ul existent al acelei locații.
4. Completează dispozitivele și IP-urile în `shelly_devices`. Dacă autentificarea locală este activă pe Shelly, completează parola în câmpul mascat `password`. Lasă `allow_hardware: false` până la verificarea fizică a configurației și a pragurilor mașinilor. Mașinile Shelly rămân indisponibile cât timp controlul fizic este oprit.
5. După verificare, marchează mașinile drept verificate fizic în CozyWash și activează `allow_hardware`. Salvează configurația și repornește add-on-ul.
6. În CozyWash → **Bridge local**, verifică apariția conexiunii și a telemetriei proaspete. Activează **Start on boot** și **Watchdog** în Home Assistant.

Exemplu de structură (valorile sunt exemple, nu credențiale):

```yaml
server_url: https://cozywash.ro
bridge_token: "TOKENUL_EMIS_PENTRU_LOCATIE"
allow_hardware: false
shelly_devices:
  - device_id: "ID_DISPOZITIV_DIN_COZYWASH"
    host: "192.168.1.50"
    password: "PAROLA_LOCALA_SHELLY_DACA_EXISTA"
```

Cu `allow_hardware: false`, lista de dispozitive poate fi goală pentru testarea conexiunii. Configurația refuză IP-uri publice, nume DNS pentru Shelly, ID-uri/IP-uri duplicate, tokenuri invalide și URL-uri cloud nesecurizate. Folosește `https://cozywash.kweb.ro` numai pentru QA și un token emis în acel mediu.

## Funcționare și repornire

La pierderea internetului, watchdog-ul nu repornește conectorul doar fiindcă serviciul CozyWash nu răspunde. Jurnalul și temporizările locale continuă. La revenirea conexiunii, comenzile și telemetria se reconciliază. O comandă deja confirmată păstrează confirmarea inițială și nu reaplică alimentarea.

La o repornire a add-on-ului sau a mini PC-ului, sesiunile fizice active sunt marcate incerte pentru verificarea operatorului. Nu sunt pornite automat încă o dată. Durata estimată a programului nu este folosită singură pentru oprirea unei mașini reale.

Datele sunt în `/data/bridge/bridge.sqlite`, cu fișierele WAL alăturate. Home Assistant include directorul privat `/data` în backup-ul add-on-ului; add-on-ul declară backup de tip cold, astfel că Supervisor îl oprește pentru o copie consistentă. Programează backup-urile când mașinile sunt inactive; o sesiune fizică activă la repornire necesită verificare. Nu șterge jurnalul pentru a „debloca” o mașină și nu restaura un jurnal vechi peste echipamente aflate în funcțiune. Nu rula două instanțe pentru aceeași locație.

## Diagnosticare

Fila **Log** afișează pornirea și coduri de diagnostic fără tokenuri, parole sau corpuri de cereri:

- `bridge_token_required`: completează tokenul emis pentru locație.
- `bridge_authentication_failed`: token revocat, greșit sau emis în celălalt mediu; verifică și URL-ul serviciului.
- `bridge_sync_unavailable`: verifică internetul, DNS-ul și accesul HTTPS. Jurnalul local continuă să funcționeze.
- `bridge_clock_out_of_sync`: corectează ora/NTP pe mini PC; activările noi sunt blocate când diferența depășește 30 de secunde.
- `private_shelly_ip_required`: introdu IP-ul privat fix al Shelly, fără protocol sau port.
- `bridge_local_journal_error`: verifică spațiul liber și stocarea Home Assistant; păstrează jurnalul pentru verificare.

Starea cloud și telemetria mașinilor se urmăresc în CozyWash → Bridge local. Endpoint-ul intern `/health` este rezervat watchdog-ului; nu publică porturi pe gazdă și nu oferă comenzi de control.

Pentru actualizare, folosește **Update** în Home Assistant și păstrează datele add-on-ului. La schimbarea tokenului sau a configurației, salvează și repornește add-on-ul. După mutarea pe alt mini PC, restaurează backup-ul și verifică fizic orice sesiune incertă înainte de a accepta rezervări noi.


## Recuperare după schimbarea IP-ului Shelly

Configurează noul IP pentru același device_id în conector și salvează/repornește. În CozyWash → Dispozitive modifică exclusiv IP-ul. Schimbarea este permisă dacă toate comenzile afectate sunt în verificare; o sesiune în desfășurare blochează în continuare schimbarea. Comenzile vechi în așteptare se anulează și citirile vechi se invalidează.

Conectorul poate muta doar adresa unui jurnal incert, păstrând canalul, pragurile, istoricul și blocarea. Citește adresa nouă numai dacă lista locală o permite pentru același dispozitiv. Nu pornește și nu oprește releul pentru recuperare. După o citire nouă care confirmă ieșirea oprită, operatorul verifică aparatul și rezolvă comanda din CozyWash → Comenzi. Jurnalul se eliberează după confirmarea serverului. Nu șterge jurnalul.
