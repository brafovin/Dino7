# APEX GP – 3D-Formel-Rennspiel für den Browser

Ein vollständig spielbares Formel-Rennspiel mit eigener Fahrphysik, 22 Fahrern in 11 Teams,
8 Strecken, KI-Gegnern, Grand Prix mit Qualifying und Boxenstopps, Zeitfahren mit Geisterauto,
Training sowie echtem Online-Multiplayer über einen Node.js/Socket.IO-Server.

> Alle Fahrzeugmodelle, Lackierungen, Helme, Fahrerkarten, Werbebanden und Texturen werden
> prozedural erzeugt. Es werden **keine offiziellen Logos, Fotos oder Fahrzeugmodelle** verwendet;
> Team- und Fahrernamen dienen nur der Auswahl. Startnummern und Helmdesigns sind stilisiert.

---

## Schnellstart

Voraussetzung: **Node.js 18 oder neuer** (getestet mit Node 22) und ein aktueller Browser
(Chrome, Edge oder Firefox) mit WebGL und Hardwarebeschleunigung.

```bash
npm install          # Abhängigkeiten installieren
npm run dev          # Entwicklung: Spiel + Multiplayer-Server
```

Dann **http://localhost:5173** öffnen. `npm run dev` startet zwei Prozesse:

| Prozess   | Adresse                 | Aufgabe                                             |
|-----------|-------------------------|-----------------------------------------------------|
| Vite      | http://localhost:5173   | Spiel-Client (Hot Reload), leitet `/socket.io` weiter |
| Server    | http://localhost:3000   | Multiplayer-Server (Lobbys, Rennwertung)            |

### Produktion / Spielen ohne Entwicklungswerkzeuge

```bash
npm run build        # Typprüfung + Client-Build (dist/) + Server-Bundle (dist-server/)
npm start            # ein Prozess: liefert Spiel UND Multiplayer aus
```

Dann **http://localhost:3000** öffnen. Port ändern: `PORT=8080 npm start`.
Kein kostenpflichtiger Dienst, keine Cloud – alles läuft lokal.

### Alle Befehle

| Befehl                | Beschreibung |
|-----------------------|--------------|
| `npm run dev`         | Client (Vite) + Server (tsx watch) für die Entwicklung |
| `npm run dev:client`  | nur Vite-Client |
| `npm run dev:server`  | nur Multiplayer-Server (Port 3000, `SERVER_PORT`/`PORT` änderbar) |
| `npm run build`       | Typprüfung, Produktions-Build von Client und Server |
| `npm start`           | gebauten Server starten (liefert `dist/` aus) |
| `npm run typecheck`   | TypeScript-Prüfung (Client + Server/Tests) |
| `npm test`            | Simulationstests + Multiplayer-Integrationstest |
| `npm run test:sim`    | Strecken, Physik, Getriebe, Rundenzeiten, KI, volle Rennen |
| `npx tsx tests/modes.test.ts` | Spielmodi & Regeln (Qualifying, Zeitfahren, Boxenstopp, Strafen) |
| `npm run test:mp`     | zwei Socket.IO-Clients gegen einen echten Serverprozess |
| `npm run test:e2e`    | zwei getrennte Browser-Clients über die echte Oberfläche (benötigt laufendes `npm run dev` und Playwright/Chromium) |

---

## Steuerung

| Aktion                         | Tastatur (Standard)   | Gamepad (Standard-Layout) |
|--------------------------------|-----------------------|---------------------------|
| Gas                            | W oder ↑              | RT                        |
| Bremse                         | S oder ↓              | LT                        |
| Lenken                         | A / D oder ← / →      | linker Stick              |
| Handbremse (Hinterachsbremse)  | Leertaste             | A                         |
| Hochschalten                   | Shift links           | RB                        |
| Runterschalten                 | Strg links            | LB                        |
| Kamera wechseln                | C                     | Y                         |
| Fahrzeug zurücksetzen          | R                     | X                         |
| Rückblick                      | B                     | B                         |
| Box-Ruf (Boxenstopp anfordern) | P                     | Steuerkreuz ↓             |
| Pause                          | Esc                   | Start                     |

* Alle Tasten sind unter **Einstellungen → Steuerung** frei belegbar (zwei Tasten je Aktion).
* Beim ersten Start erscheint automatisch eine Kurzanleitung (später über **Hauptmenü → Steuerung**).
* „Handbremse“: Formelautos haben keine Handbremse – die Leertaste bremst gezielt die Hinterachse
  (ohne ABS). Das kann zum Eindrehen in Haarnadeln genutzt werden.
* Rückwärts: Im Stand die Bremse gedrückt halten (Automatik) bzw. im 1. Gang herunterschalten (Manuell).
* Gamepads werden über die Gamepad-API erkannt; Vibration wird genutzt, wenn das Gerät sie unterstützt.
* Box-Ruf: erneut drücken sagt den Stopp wieder ab; alternativ im Pausemenü
  („Boxenstopp anfordern“ inkl. Wahl der Reifenmischung).

---

## Spielmodi

### Grand Prix
Fahrer/Team → Strecke → Rennkonfiguration (Runden, Anzahl KI-Gegner 0–21, Schwierigkeit, Wetter,
Reifenverschleiß, Startreifen, Startaufstellung). Startaufstellung wahlweise per **Qualifying**
(Aufwärmrunde + 2 gezeitete Runden; die KI-Runden werden parallel echt simuliert), zufällig,
von der Pole oder vom letzten Platz.

Rennablauf: Startaufstellung → fünf Startampeln mit zufälliger Wartezeit → Rennen mit
Positionsberechnung, Abständen (Zeitmessung über Streckenmarker), schnellsten Runden,
Boxenstopps, Strafen → Zielflagge → Ergebnis mit Platzierung, Zeit/Abstand, bester Runde,
Stopps und Strafen. Nach deiner Zieldurchfahrt übernimmt ein Autopilot die Auslaufrunde, das Ergebnis
aktualisiert sich live; „Rennen beenden“ wertet nicht angekommene Fahrzeuge hochgerechnet (markiert mit `*`).

### Boxenstopps und Boxengasse
Jede Strecke hat eine Boxengasse mit Ein- und Ausfahrt, Boxenmauer, 80-km/h-Tempolimit
(Schilder „80“/„ENDE 80“, HUD-Anzeige „PIT 80“), elf Boxenplätzen in Teamfarben
mit Teamnamen, Reifenstapeln und einer Ampel an der Ausfahrt. In jeder Box steht eine animierte
**Boxencrew** (11 Mechaniker), die nur antritt, wenn ihr Auto kommt, und sich beim Reifenwechsel
an die Räder kniet; das Auto wird dabei angehoben.

* **Box-Ruf** (Taste **P** / Steuerkreuz ↓ / Pausemenü): Das HUD zeigt „Box, Box!“ mit der
  Entfernung zur Einfahrt und der Seite (links/rechts rein).
* **Boxengassen-Assistent** (Fahrhilfe, standardmäßig an, bei „Experte“ standardmäßig aus): ca. 200 m vor der
  Einfahrt übernimmt der Assistent, fährt mit Tempolimit zur eigenen Teambox, hält an und bringt
  das Auto nach dem Stopp bis zurück auf die Strecke – danach fährst du wieder selbst.
* Ohne Assistent fährst du selbst: auf der Boxenseite in die Gasse, vor der Limit-Linie auf
  80 km/h bremsen (ab der Linie hält der Begrenzer das Tempo, bremst aber nicht für dich – wer im
  Rennen mit über 83 km/h über die Linie fährt, bekommt +5 s), in der eigenen, farbig markierten
  Box anhalten.
* Stopp: 2,1–3,0 s Standzeit (HUD mit Fortschrittsbalken), neue Reifen der gewählten Mischung,
  Verschleiß zurückgesetzt. Pro Durchfahrt höchstens ein Stopp; die Durchfahrt ohne Box-Ruf
  kostet nur Zeit.
* KI-Fahrer kommen bei starkem Reifenverschleiß selbstständig an die Box (eigene Strategie für
  die Reifenwahl), fahren über den Boxenpfad und reihen sich danach wieder ein.

### Zeitfahren
Allein auf der Strecke, Zeitnahme ab der Ziellinie, Sektorzeiten (lila = Bestwert, grün =
persönliche Bestzeit, gelb = langsamer), Live-Delta zur besten Runde, persönliche Bestzeit pro
Strecke im `localStorage` – inkl. **Geisterauto** der Bestzeitrunde. Verlassen der Strecke
(alle Räder neben Curb) oder Zurücksetzen macht die Runde ungültig.

### Training
Freies Fahren ohne Rennzwang, Fahrhilfen und Einstellungen jederzeit im Pausemenü änderbar.

### Online-Multiplayer
Siehe Abschnitt [Multiplayer](#multiplayer).

---

## Teams und Fahrer

11 Teams mit je 2 Fahrern (alle im Auswahlmenü mit stilisierter Fahrerkarte, Startnummer, Team):

| Team            | Fahrer |
|-----------------|--------|
| Ferrari         | Charles Leclerc, Lewis Hamilton |
| McLaren         | Lando Norris, Oscar Piastri |
| Mercedes        | George Russell, Andrea Kimi Antonelli |
| Red Bull Racing | Max Verstappen, Isack Hadjar |
| Aston Martin    | Fernando Alonso, Lance Stroll |
| Cadillac        | Valtteri Bottas, Sergio Pérez |
| Haas            | Oliver Bearman, Esteban Ocon |
| Racing Bulls    | Liam Lawson, Arvid Lindblad |
| Williams        | Alexander Albon, Carlos Sainz |
| Audi            | Nico Hülkenberg, Gabriel Bortoleto |
| Alpine          | Pierre Gasly, Franco Colapinto |

Jedes Team hat eine eigene prozedurale Lackierung (Farben + Muster), eigene Teamfarben im HUD und
leicht unterschiedliche Leistungswerte (Motorleistung, Abtrieb, Luftwiderstand, Reifenverschleiß –
Spannweite nur wenige Prozent). Fahrer haben KI-Werte für Tempo, Zweikampf, Konstanz und Nässe.

---

## Strecken

| Strecke                  | Länge (exakt) | Charakter |
|--------------------------|---------------|-----------|
| Silverstone              | 5,891 km | schnelle Kurvenkombinationen (Maggotts/Becketts), Hangar Straight |
| Monaco                   | 3,337 km | 9,5 m schmal, Leitplanken direkt neben der Fahrbahn, Haarnadel, Tunnel, 40 m Höhenunterschied |
| Monza                    | 5,793 km | lange Geraden, Schikanen, Parabolica, Windschatten |
| Spa-Francorchamps        | 7,004 km | Eau Rouge/Raidillon (Senke mit Kompression + steiler Anstieg), Kemmel-Gerade, ~75 m Höhenunterschied |
| Suzuka                   | 5,807 km | echte Achterschleife mit **Brücke** (Unterführung/Überführung), S-Kurven, 130R |
| Circuit of the Americas  | 5,513 km | steiler Anstieg zu Turn 1, Esses, lange Gegengerade, Stadion-Sektion |
| Yas Marina               | 5,281 km | Abendrennen mit Flutlicht, lange Geraden, Hotel-Brücke über der Strecke, Marina |
| Zandvoort                | 4,259 km | Dünenkurs mit überhöhten Kurven (Hugenholtz 19°, Luyendyk 18°) |

**Ehrlicher Hinweis:** Die Layouts sind **vereinfachte, an die Originale angelehnte Nachbauten**
(Kurvenabfolge, Kurvennamen, Charakter, Höhenprofil, Fahrtrichtung). Sie sind keine exakten
Vermessungen. Die Gesamtlänge wird jedoch exakt auf den realen Wert skaliert. Jede Strecke hat
Asphalt, Curbs, Auslaufzonen (Gras/Kies/Asphalt), Barrieren (Leitplanken/Betonwände mit
Werbebanden/Tecpro), Fangzäune, Start- und Ziellinie, Startaufstellung mit 22 Plätzen,
Boxengasse mit Garagen, Boxenmauer und Tempolimit, Tribünen mit Publikum, eigene Umgebung
(Wald, Stadt, Wüste, Dünen, Wasser, Berge) und Beleuchtung, Bremsschilder sowie drei Sektoren.

---

## Fahrphysik (Modell und Vereinfachungen)

Datei: `src/shared/carPhysics.ts`. Ein ebenes Starrkörpermodell mit vier Rädern, gerechnet mit
240 Hz (fester Takt 120 Hz × 2 Teilschritte):

* **Reifen:** Seitenkraft nach einer Magic-Formula-Kurve (Spitze bei ~5–6° Schlupfwinkel, Abfall
  im Gleiten), lastabhängiger Reibwert (mehr Last → relativ weniger Grip), Reibungskreis für
  kombinierten Schlupf. Übersteigt die Antriebs- oder Bremskraft die Haftung, drehen die Räder
  durch bzw. blockieren – dann bricht die Seitenführung ein (Übersteuern beim zu frühen Gasgeben,
  Untersteuern bei blockierten Vorderrädern).
* **Radlasten:** Gewicht, Abtrieb (∝ v²) mit Aero-Balance, Längslastverlagerung beim
  Bremsen/Beschleunigen, Querlastverlagerung mit Wankverteilung, Steigung, Querneigung (Banking)
  und Kuppen/Senken (Kompression in Eau Rouge).
* **Aerodynamik:** Luftwiderstand und Abtrieb ∝ v², Windschatten reduziert den Widerstand
  (und leicht den Abtrieb).
* **Antrieb:** Leistungskurve über Drehzahl, 8-Gang-Getriebe (ca. 108–345 km/h je Gang bei
  Höchstdrehzahl), Schaltzeit, Drehzahlbegrenzer, Motorbremse, Anfahrkupplung im 1. Gang,
  ERS-Boost/Rekuperation, Kraftstoffverbrauch und -masse.
* **Untergründe:** Curbs (weniger Grip, rutschig bei Nässe, Vibration), Gras, Kies (hoher
  Rollwiderstand), Asphalt-Auslaufzonen, Boxengasse.
* **Nässe:** geringere Haftung je Reifenmischung (Slicks stark, Intermediates/Regenreifen besser).
* **Reifenverschleiß:** proportional zur in der Kontaktfläche dissipierten Energie, abhängig von
  Mischung und Team; abgefahrene Reifen verlieren Grip.
* **Kollisionen:** Fahrzeug gegen Barriere/Boxenmauer (Impuls mit Restitution, Reibung und
  Gierimpuls) und Fahrzeug gegen Fahrzeug (Kreis-Approximation mit Impulsen).

Kennwerte aus den Tests: 0–100 km/h ≈ 2,3 s, 0–200 km/h ≈ 4,5 s, Höchstgeschwindigkeit ≈ 348 km/h,
Bremsweg 300→80 km/h ≈ 90 m, Quer-g bei 180 km/h ≈ 2,9 g (trocken).

**Vereinfachungen:** keine einzelnen Radrotationsfreiheitsgrade (Längsschlupf wird über das
Verhältnis Kraftwunsch/Haftung modelliert), kein Federungs-/Dämpfermodell (Nicken/Wanken nur
visuell), Fahrzeug bleibt immer am Boden, keine Reifentemperatur, kein Fahrzeugschaden,
vereinfachte Differenzialsperre, Banking-Effekt nur über die Gravitationskomponente.

---

## Einstellungen

Alle Einstellungen werden automatisch im `localStorage` gespeichert.

**Schwierigkeitsgrad** (beeinflusst KI-Tempo, verfügbare Fahrhilfen und Stabilitätshilfe – nicht
die Leistung deines Autos):

| Stufe    | KI (Grip-Ausnutzung) | Hilfen |
|----------|----------------------|--------|
| Anfänger | 84 %, vorsichtig     | alle verfügbar, starke Stabilitätshilfe, Standard: TC hoch, ABS, volle Ideallinie, Lenk- und Bremsassistent |
| Einfach  | 89 %                 | alle verfügbar, leichte Stabilitätshilfe |
| Normal   | 93 %                 | alle verfügbar, keine Stabilitätshilfe, Bremshinweis an |
| Schwer   | 96 %                 | kein Brems-/Lenkassistent |
| Experte  | 98 %, aggressiv      | nur TC (aus/niedrig) und ABS, keine Ideallinie, kein Bremshinweis, kein Autoreset |

**Getriebe:** Automatik (schaltet nach Drehzahl/Last, schaltet beim Bremsen herunter) oder
Manuell (Schaltblitz-LEDs, zu hoher Gang = kaum Leistung, Drehzahlbegrenzer, Überdrehschutz
verweigert zu frühes Runterschalten, aggressives Runterschalten erzeugt starke Motorbremse).

**Fahrhilfen:** Traktionskontrolle (Aus/Niedrig/Hoch), ABS (Aus/Ein), Ideallinie
(Aus/Nur Kurven/Vollständig – grün = Gas, gelb = lupfen, rot = bremsen), Lenkhilfe (Ein/Aus),
Bremsassistent (Ein/Aus), **Bremshinweis / Bremslinie** (Ein/Aus), automatische Rücksetzung (Ein/Aus),
Boxengassen-Assistent (Ein/Aus).

**Bremshinweis (Bremslinie):** Vor jeder Kurve, in der du bei deinem aktuellen Tempo bremsen musst,
steht am Bremspunkt eine rote Linie quer über die Fahrbahn (Pfeilmarkierung am Boden, rot-weiße
Pfosten und Banner „BREMSEN“ darüber – aus der Ferne sichtbar). Gelb mit „GAS WEG“ bedeutet: nur
lupfen. Im HUD erscheint ca. 2,5 s vorher „Bremsen in … m“ mit Zieltempo und Countdown-Balken, am
Punkt selbst „BREMSEN!“. Der Punkt wird aus deinem Geschwindigkeitsprofil und deinem
aktuellen Tempo berechnet (schneller = früher bremsen), liegt bewusst ca. 0,25 s vor dem
spätestmöglichen Punkt (Reaktionszeit) und bleibt kurz vor dem Erreichen fest stehen. Ist die
Ideallinie eingeschaltet, beginnt ihr roter Abschnitt exakt an derselben Stelle. Standard: an
(Anfänger bis Normal), aus bei Schwer, bei Experte nicht verfügbar; auch im Pausemenü umschaltbar.

**Weitere:** Grafikqualität (Niedrig/Mittel/Hoch), FPS-Anzeige, Lenkempfindlichkeit,
Gamepad-Lenkkurve und -Totzone, Vibration, Lautstärken (Gesamt, Motor, Umgebung, Effekte),
Kamera (Standardperspektive, Sichtfeld, Kamerawackeln), Tastenbelegung, Spielername.

**Kameras:** TV-Kamera, nah, weit, Cockpit, Frontkamera (Nase), Verfolger-/Streckenkameras;
Rückblick mit B.

---

## Multiplayer

### Ein Rechner / LAN

1. Server starten: `npm run dev` (Entwicklung) **oder** `npm run build && npm start`.
2. Spieler 1 öffnet das Spiel → **Online-Multiplayer** → Namen eingeben → **Lobby erstellen**.
   Der 5-stellige Lobby-Code wird angezeigt (Button „Code kopieren“).
3. Spieler 2 öffnet das Spiel (anderer Browser/Rechner) → **Online-Multiplayer** → Code eingeben →
   **Beitreten**.
   * Im LAN unter „Server-Adresse“ die Adresse des Server-Rechners eintragen, z. B.
     `http://192.168.0.10:3000` (Produktion) – oder direkt `http://192.168.0.10:5173` öffnen
     (Entwicklung; Vite lauscht im Netzwerk und leitet den Multiplayer weiter). Ggf. Firewall
     für Port 3000/5173 freigeben.
4. Jeder wählt einen Fahrer (jeder Fahrer nur einmal pro Lobby), Gäste klicken **Bereit**.
5. Der Host wählt Strecke, Runden (1–15) und Wetter und klickt **Rennen starten**.

### Architektur

* **Server-autoritativ:** Rundenzählung (mit Sektor-Kontrollpunkten gegen Abkürzungen),
  Positionen, Abstände, Zieleinlauf und Ergebnis berechnet der Server mit demselben Strecken- und
  Rundenmodell wie der Client (`src/shared`).
* **Validierung:** alle Nachrichten werden typ- und wertgeprüft; unplausible Positionssprünge
  (mehr als max. Geschwindigkeit × Zeit), Positionen außerhalb der Barrieren und Frühstarts werden
  verworfen und der Client erhält eine **Korrektur**; Ratenbegrenzung pro Client.
* **Synchronisierung:** Jeder Client simuliert sein eigenes Auto lokal (keine Eingabeverzögerung)
  und sendet den Zustand mit 20 Hz; der Server verteilt Snapshots mit 20 Hz. Mitspieler werden mit
  ~110 ms Verzögerung per **Hermite-Interpolation** (Position + Geschwindigkeit) dargestellt, bei
  Paketverlust bis 250 ms extrapoliert. Uhrensynchronisierung über Ping/Pong → gemeinsame
  Startampel nach Serverzeit.
* **HUD:** Verbindungsstatus, Ping und Spielerzahl; Lobby zeigt Ping, Bereit-Status und Host.
* **Verlassen:** Spieler können Lobby oder Rennen verlassen (im Rennen als „Getrennt“ gewertet),
  der Host wird bei Bedarf automatisch übertragen, leere Lobbys werden entfernt.
* Getestet mit 2 Spielern (Integrationstest und Browser-E2E), Architektur bis 12 Spieler pro Lobby.
* Im Multiplayer fahren **keine KI-Fahrzeuge** mit – nur echte Spieler.

---

## Projektstruktur

```
index.html              Einstieg (Vite)
server/index.ts         Multiplayer-Server (Socket.IO) + Auslieferung von dist/
src/shared/             geteilte, DOM-freie Logik (Client, Server, Tests)
  track.ts trackDefs.ts   Streckenmodell und die 8 Layouts
  carPhysics.ts           Fahrphysik
  collisions.ts           Kollisionen
  racingLine.ts ai.ts     Ideallinie, Geschwindigkeitsprofil, KI-Fahrer
  lapTracker.ts           Runden-/Sektorzeiten
  protocol.ts teams.ts    Netzwerkprotokoll, Teams & Fahrer
src/sim/                Einzelspieler-Rennsitzung, Konfiguration, Schwierigkeitsgrade
src/game/               RaceController (Spielschleife eines Rennens)
src/render/             Three.js: Renderer, Strecke, Fahrzeug, Kamera, Effekte, Showroom
src/audio/              WebAudio-Synthese (Motor, Reifen, Wind, …)
src/input/              Tastatur, Gamepad, Vibration
src/net/                Netzwerk-Client und Mehrspieler-Sitzung
src/ui/                 Menüs, HUD, Minikarte, Fahrerkarten, CSS
tests/                  Simulations-, Modus-, Multiplayer- und Browser-Tests
tools/                  Entwicklungswerkzeuge (Streckenvorschau, Screenshots)
```

---

## Technik

TypeScript 5.7 · Vite 6.4 · Three.js 0.170 · Socket.IO 4.8 · Node.js ≥ 18.

**Rapier wurde bewusst nicht verwendet:** Für ein Formelauto auf einer abgetasteten Strecke ist ein
eigenes, deterministisches Fahrzeugmodell genauer steuerbar als ein allgemeiner Raycast-Vehicle-
Controller. Vor allem kann dieselbe Physik- und Streckenlogik unverändert auf dem Server (Validierung,
Rundenwertung) und in Headless-Tests laufen, ohne WebAssembly.

Stabilität und Leistung: fester Simulationstakt mit Render-Interpolation, Frame-Zeit auf 0,1 s
begrenzt (kein „Aufholen“ nach Tab-Wechsel), Einzelspieler pausiert automatisch beim Tab-Wechsel,
zusammengeführte Geometrien und Instancing (Publikum, Bäume, Gebäude), Schatten-Kamera folgt dem
Spieler, HUD-Aktualisierung gedrosselt, Event-Listener und Netzwerkverbindungen werden beim
Verlassen aufgeräumt, globale Fehlerbehandlung mit verständlichen Meldungen.

---

## Bekannte Einschränkungen

* Streckenlayouts sind angenäherte Nachbauten (siehe oben), keine exakten Vermessungen.
* Fahrzeugmodelle und Lackierungen sind eigenständige, stilisierte Designs.
* Kein Schadensmodell, keine Reifentemperatur, kein Federungsmodell; das Auto kann nicht abheben.
* Boxenstopps: nur Reifenwechsel (kein Nachtanken, keine Reparaturen, kein „Unsafe Release“);
  die Boxencrew ist eine einfache, stilisierte Animation (Figuren gehen in Position, knien beim
  Reifenwechsel) ohne einzelne Handgriffe. Im Multiplayer ist der Boxenstopp clientseitig; der
  Server sieht nur den Status „in der Box“.
* KI überholt vorsichtig; in engen Passagen (Monaco) kommt es selten zu Überholmanövern.
* Multiplayer: Kollisionen zwischen Mitspielern werden von jedem Client für das eigene Auto
  aufgelöst (keine serverseitige Kollisionsphysik); bei hohem Ping können kurze Überlappungen
  sichtbar sein. Keine Wiederverbindung in ein laufendes Rennen. Kein Matchmaking/Internet-Relay –
  für Spiele über das Internet muss der Server erreichbar gehostet werden.
* Strafen: Abkürzungen (Zeitgewinn neben der Strecke) und Tempoüberschreitungen in der Boxengasse
  werden geahndet; es gibt keine Kollisionsstrafen, keine Flaggen-/Safety-Car-Phasen.
* Grafikqualität „Hoch“ (Bloom, große Schattenkarte) ist für dedizierte Grafikkarten gedacht;
  auf integrierten GPUs „Mittel“ oder „Niedrig“ wählen. Änderungen an der Qualität wirken auf die
  Streckenszene ab dem nächsten Rennen.
* Audio startet erst nach der ersten Benutzerinteraktion (Browser-Richtlinie).
