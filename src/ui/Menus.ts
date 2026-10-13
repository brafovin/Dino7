// Alle Menübildschirme.
import type { App } from '../app/App';
import { ACTION_LABELS, type Action, CAMERA_MODES, DEFAULT_BINDINGS, keyLabel, loadBestLaps, type Quality } from '../settings';
import { COMPOUNDS, type Compound } from '../shared/carPhysics';
import { formatTime } from '../shared/math';
import { MAX_LAPS } from '../shared/protocol';
import { ALL_DRIVERS, getDriver, getTeam, TEAMS } from '../shared/teams';
import { Track } from '../shared/track';
import { TRACK_DEFS } from '../shared/trackDefs';
import { DIFFICULTIES, type GameMode, getDifficulty, type LineMode, type TcLevel, WEAR_OPTIONS } from '../sim/config';
import type { ResultRow } from '../sim/RaceSession';
import { clear, h, segmented, slider } from './dom';
import { driverPortraitSVG, trackOutlineSVG } from './portraits';

const trackCache = new Map<string, Track>();
export function getPreviewTrack(id: string): Track {
  let t = trackCache.get(id);
  if (!t) {
    t = new Track(TRACK_DEFS.find((d) => d.id === id)!);
    trackCache.set(id, t);
  }
  return t;
}

const TIPS = [
  'Bremse auf der Geraden – nicht in der Kurve. Erst bremsen, dann einlenken.',
  'Zu frühes Vollgas am Kurvenausgang lässt die Hinterräder durchdrehen.',
  'Mit „C“ wechselst du die Kamera, mit „R“ setzt du dein Auto auf die Strecke zurück.',
  'Im Windschatten sinkt der Luftwiderstand – ideal zum Überholen auf langen Geraden.',
  'Bei Nässe sind die bemalten Curbs besonders rutschig.',
  'Abtrieb wächst mit dem Quadrat der Geschwindigkeit: schnelle Kurven vertragen mehr als man denkt.',
  'Reifenverschleiß kostet Grip – fahre in die Boxengasse und halte in deiner Box für frische Reifen.',
  'Im manuellen Modus: Die blauen Schaltlichter signalisieren den idealen Schaltpunkt.',
];

export class Menus {
  private readonly app: App;
  private readonly root: HTMLElement;
  private readonly overlay: HTMLElement;
  private toastWrap: HTMLDivElement;
  private unsubs: (() => void)[] = [];

  constructor(app: App, root: HTMLElement, overlay: HTMLElement) {
    this.app = app;
    this.root = root;
    this.overlay = overlay;
    this.toastWrap = h('div', { class: 'toast-wrap' });
    overlay.appendChild(this.toastWrap);
  }

  private screen(cls = 'screen dim'): HTMLDivElement {
    this.cleanup();
    clear(this.root);
    const s = h('div', { class: cls });
    this.root.appendChild(s);
    return s;
  }

  private cleanup(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.app.input.cancelCapture();
  }

  hide(): void {
    this.cleanup();
    clear(this.root);
  }

  toast(text: string, bad = false): void {
    const t = h('div', { class: `toast ${bad ? 'bad' : ''}` }, text);
    this.toastWrap.appendChild(t);
    window.setTimeout(() => t.remove(), 3500);
  }

  private topbar(title: string, sub: string, back?: () => void): HTMLElement {
    return h(
      'div',
      { class: 'topbar' },
      back ? h('button', { class: 'btn ghost', onclick: back }, '← Zurück') : null,
      h('h2', { class: 'title' }, h('small', null, sub), title),
    );
  }

  // ------------------------------------------------------------------ Hauptmenü

  main(): void {
    const app = this.app;
    const s = this.screen('screen dim main-menu');
    const d = getDriver(app.settings.data.race.driverId);
    const team = getTeam(d.teamId);
    app.showroomCar(team, d);
    const item = (ico: string, label: string, sub: string, fn: () => void) =>
      h('button', { class: 'menu-item', onclick: () => (app.click(), fn()) }, h('span', { class: 'ico' }, ico), h('span', null, label, h('small', null, sub)));
    s.append(
      h('h1', { class: 'logo' }, 'Apex', h('span', null, ' GP')),
      h('div', { class: 'logo-sub' }, 'Formel-Rennsport · 3D'),
      h(
        'div',
        { class: 'menu-list' },
        item('▶', 'Spielmodus wählen', 'Grand Prix · Zeitfahren · Training', () => this.modeSelect()),
        item('◎', 'Online-Multiplayer', 'Lobby erstellen oder per Code beitreten', () => this.lobbyConnect()),
        item('⚙', 'Einstellungen', 'Schwierigkeit · Fahrhilfen · Grafik · Audio · Steuerung', () => this.settings(() => this.main())),
        item('⌨', 'Steuerung', 'Tastatur- und Gamepad-Belegung', () => this.controlsHelp()),
      ),
      h('div', { class: 'footer-note' }, `Fahrer: ${d.name} · ${team.name} · Schwierigkeit: ${getDifficulty(app.settings.data.difficulty).name}`),
    );
    this.root.appendChild(
      h('div', { class: 'showcase-tag' }, h('div', { class: 'team' }, team.name), h('div', { class: 'driver' }, d.name), h('div', { class: 'team' }, `#${d.number}`)),
    );
  }

  // ------------------------------------------------------------------ Modus

  modeSelect(): void {
    const s = this.screen();
    s.append(this.topbar('Spielmodus', 'Wähle dein Rennen', () => this.main()));
    const card = (mode: GameMode | 'mp', ico: string, title: string, text: string) =>
      h(
        'div',
        {
          class: 'card mode-card',
          tabindex: '0',
          onclick: () => {
            this.app.click();
            if (mode === 'mp') this.lobbyConnect();
            else {
              this.app.flow.mode = mode;
              this.driverSelect(() => this.trackSelect());
            }
          },
        },
        h('div', { class: 'big-ico' }, ico),
        h('h3', null, title),
        h('p', null, text),
      );
    s.append(
      h(
        'div',
        { class: 'cards' },
        card('grandprix', '🏁', 'Grand Prix', 'Qualifying optional, Startaufstellung, Rennen gegen bis zu 21 KI-Gegner, Boxenstopps und Ergebnis.'),
        card('timetrial', '⏱', 'Zeitfahren', 'Allein auf der Strecke: Rundenzeiten, Sektoren, Delta und Geisterauto deiner Bestzeit.'),
        card('practice', '🔧', 'Training', 'Freies Fahren ohne Rennzwang – Fahrhilfen und Einstellungen ausprobieren.'),
        card('mp', '🌐', 'Online-Multiplayer', 'Lobby erstellen, Code teilen, gemeinsam starten – synchronisiert über den Server.'),
      ),
    );
  }

  // ------------------------------------------------------------------ Fahrer

  driverSelect(next: () => void, opts: { taken?: Set<string>; back?: () => void; title?: string } = {}): void {
    const app = this.app;
    const s = this.screen();
    let selected = app.settings.data.race.driverId;
    if (opts.taken?.has(selected)) selected = ALL_DRIVERS.find((d) => !opts.taken!.has(d.id))?.id ?? selected;
    s.append(this.topbar(opts.title ?? 'Fahrer & Team', '11 Teams · 22 Fahrer', opts.back ?? (() => this.modeSelect())));
    const grid = h('div', { class: 'team-grid' });
    const cards: HTMLElement[] = [];
    const refresh = () => cards.forEach((c) => c.classList.toggle('selected', c.dataset.id === selected));
    const perfBar = (label: string, v: number, inv = false) => {
      const f = Math.max(0.05, Math.min(1, 0.5 + (inv ? 1 - v : v - 1) * 18));
      return h('span', null, label, ' ', h('span', { class: 'perf-bar' }, h('i', { style: `width:${(f * 100).toFixed(0)}%` })));
    };
    for (const team of TEAMS) {
      const row = h('div', { class: 'driver-row' });
      for (const d of team.drivers) {
        const taken = opts.taken?.has(d.id) ?? false;
        const c = h(
          'div',
          {
            class: `driver-card ${taken ? 'taken' : ''}`,
            'data-id': d.id,
            title: taken ? 'Bereits von einem anderen Spieler gewählt' : d.name,
            onclick: () => {
              if (taken) return;
              selected = d.id;
              app.click();
              refresh();
              app.showroomCar(team, d);
            },
          },
          h('div', { class: 'portrait', html: driverPortraitSVG(d, team) }),
          h('div', null, h('div', { class: 'dname' }, d.name), h('div', { class: 'dmeta' }, h('span', { class: 'dnum' }, `#${d.number}`), ` · ${d.code} · ${d.nation}`)),
        );
        cards.push(c);
        row.appendChild(c);
      }
      grid.appendChild(
        h(
          'div',
          { class: 'team-block' },
          h(
            'div',
            { class: 'team-head', style: `background: linear-gradient(90deg, ${team.livery.primary}33, transparent)` },
            h('span', { class: 'swatch', style: `background:${team.livery.primary}` }),
            h('span', { class: 'swatch', style: `background:${team.livery.secondary}` }),
            team.name,
            h('span', { class: 'perf' }, perfBar('Motor', team.perf.power), perfBar('Abtrieb', team.perf.downforce), perfBar('Aero', team.perf.drag, true)),
          ),
          row,
        ),
      );
    }
    refresh();
    s.append(
      grid,
      h(
        'div',
        { class: 'bottombar' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              app.click();
              app.settings.update((x) => (x.race.driverId = selected));
              next();
            },
          },
          'Weiter →',
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ Strecke

  trackSelect(next?: () => void, back?: () => void): void {
    const app = this.app;
    const s = this.screen();
    let selected = app.settings.data.race.trackId;
    s.append(this.topbar('Strecke', '8 Rennstrecken', back ?? (() => this.driverSelect(() => this.trackSelect()))));
    const best = loadBestLaps();
    const cards: HTMLElement[] = [];
    const wrap = h('div', { class: 'cards' });
    for (const def of TRACK_DEFS) {
      const tr = getPreviewTrack(def.id);
      const c = h(
        'div',
        {
          class: 'card track-card',
          'data-id': def.id,
          onclick: () => {
            selected = def.id;
            app.click();
            cards.forEach((x) => x.classList.toggle('selected', x.dataset.id === selected));
          },
        },
        h('div', { class: 'outline', html: trackOutlineSVG(tr, '#e9edf3', 3) }),
        h('h3', null, def.name),
        h('p', null, `${def.location}, ${def.country}`),
        h(
          'div',
          { class: 'meta' },
          h('span', { class: 'chip flag' }, def.flag),
          h('span', { class: 'chip' }, `${def.lengthKm.toFixed(3).replace('.', ',')} km`),
          h('span', { class: 'chip' }, `${def.realLaps} Rd. (Original)`),
          h('span', { class: 'chip' }, def.env.time === 'dusk' ? 'Flutlicht' : def.dir === 'fig8' ? 'Achterschleife' : def.dir === 'cw' ? 'Uhrzeigersinn' : 'Gegen Uhrzeigersinn'),
        ),
        h('p', { style: 'margin-top:8px' }, def.character),
        best[def.id] ? h('p', { style: 'margin-top:4px;color:#c88cff' }, `Persönliche Bestzeit: ${formatTime(best[def.id].time)}`) : null,
      );
      cards.push(c);
      wrap.appendChild(c);
    }
    cards.forEach((x) => x.classList.toggle('selected', x.dataset.id === selected));
    s.append(
      wrap,
      h(
        'div',
        { class: 'bottombar' },
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              app.click();
              app.settings.update((x) => (x.race.trackId = selected));
              (next ?? (() => this.raceConfig()))();
            },
          },
          'Weiter →',
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ Rennkonfiguration

  raceConfig(): void {
    const app = this.app;
    const st = app.settings;
    const r = st.data.race;
    const mode = app.flow.mode;
    const s = this.screen();
    const def = TRACK_DEFS.find((d) => d.id === r.trackId)!;
    const title = mode === 'grandprix' ? 'Rennkonfiguration' : mode === 'timetrial' ? 'Zeitfahren' : 'Training';
    s.append(this.topbar(title, `${def.name} · ${getDriver(r.driverId).name}`, () => this.trackSelect()));
    const grid = h('div', { class: 'form-grid' });
    const race = h('div', { class: 'panel' }, h('h4', null, 'Rennen'));
    if (mode === 'grandprix') {
      const [lapsIn, lapsOut] = slider(1, Math.min(def.realLaps, MAX_LAPS), 1, Math.min(r.laps, def.realLaps), (v) => st.update((x) => (x.race.laps = v)), (v) => `${v} Runden · ${((v * def.lengthKm)).toFixed(1)} km`);
      const [aiIn, aiOut] = slider(0, 21, 1, r.aiCount, (v) => st.update((x) => (x.race.aiCount = v)), (v) => `${v} Gegner`);
      race.append(
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Renndistanz', lapsOut), lapsIn),
        h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'KI-Gegner', aiOut), aiIn),
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'lbl' }, 'Startaufstellung'),
          segmented(
            [
              { label: 'Qualifying', value: 'qualifying' },
              { label: 'Zufällig', value: 'random' },
              { label: 'Pole', value: 'pole' },
              { label: 'Letzter', value: 'back' },
            ],
            r.startMode,
            (v) => st.update((x) => (x.race.startMode = v)),
          ),
          h('div', { class: 'hint' }, 'Qualifying: eine Aufwärmrunde und zwei gezeitete Runden bestimmen deinen Startplatz.'),
        ),
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'lbl' }, 'Reifenverschleiß'),
          segmented(WEAR_OPTIONS.map((o) => ({ label: o.label, value: o.value })), r.wearScale, (v) => st.update((x) => (x.race.wearScale = v))),
        ),
      );
    }
    race.append(
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'lbl' }, 'Wetter'),
        segmented(
          [
            { label: '☀ Trocken', value: 'dry' },
            { label: '🌧 Regen', value: 'wet' },
          ],
          r.weather,
          (v) => st.update((x) => (x.race.weather = v)),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'lbl' }, 'Startreifen'),
        segmented(
          (['soft', 'medium', 'hard', 'inter', 'wet'] as Compound[]).map((c) => ({ label: COMPOUNDS[c].name, value: c })),
          app.flow.compound,
          (v) => (app.flow.compound = v),
        ),
        h('div', { class: 'hint' }, 'Bei Regen werden automatisch Intermediates verwendet, wenn Slicks gewählt sind.'),
      ),
    );
    grid.append(race, this.assistPanel(), this.difficultyPanel(() => this.raceConfig()));
    s.append(grid);
    s.append(
      h(
        'div',
        { class: 'bottombar' },
        h('button', { class: 'btn', onclick: () => this.settings(() => this.raceConfig()) }, 'Alle Einstellungen'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              app.click();
              app.startFromMenu();
            },
          },
          mode === 'grandprix' ? (r.startMode === 'qualifying' ? 'Zum Qualifying ▶' : 'Rennen starten ▶') : 'Losfahren ▶',
        ),
      ),
    );
  }

  private difficultyPanel(rerender: () => void): HTMLElement {
    const st = this.app.settings;
    const d = getDifficulty(st.data.difficulty);
    return h(
      'div',
      { class: 'panel' },
      h('h4', null, 'Schwierigkeitsgrad'),
      h(
        'div',
        { class: 'field' },
        segmented(
          DIFFICULTIES.map((x) => ({ label: x.name, value: x.id })),
          st.data.difficulty,
          (v) => {
            st.setDifficulty(v);
            rerender();
          },
        ),
        h('div', { class: 'hint' }, d.description),
      ),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'lbl' }, 'Getriebe'),
        segmented(
          [
            { label: 'Automatik', value: 'auto' },
            { label: 'Manuell', value: 'manual' },
          ],
          st.data.transmission,
          (v) => st.update((x) => (x.transmission = v)),
        ),
        h('div', { class: 'hint' }, 'Manuell: Shift links = hoch, Strg links = runter. Falsche Gänge kosten Leistung.'),
      ),
    );
  }

  private assistPanel(): HTMLElement {
    const st = this.app.settings;
    const d = getDifficulty(st.data.difficulty);
    const a = st.data.assists;
    const panel = h('div', { class: 'panel' }, h('h4', null, `Fahrhilfen (${d.name})`));
    const yesNo = (key: 'abs' | 'steering' | 'brake' | 'autoReset' | 'pitAssist', label: string, hint: string) =>
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'lbl' }, label),
        segmented(
          [
            { label: 'Aus', value: false, disabled: !d.allowed[key].includes(false) },
            { label: 'Ein', value: true, disabled: !d.allowed[key].includes(true) },
          ],
          a[key],
          (v) => st.update((x) => (x.assists[key] = v)),
        ),
        h('div', { class: 'hint' }, hint),
      );
    panel.append(
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'lbl' }, 'Traktionskontrolle'),
        segmented(
          (['off', 'low', 'high'] as TcLevel[]).map((v) => ({ label: v === 'off' ? 'Aus' : v === 'low' ? 'Niedrig' : 'Hoch', value: v, disabled: !d.allowed.tc.includes(v) })),
          a.tc,
          (v) => st.update((x) => (x.assists.tc = v)),
        ),
      ),
      yesNo('abs', 'ABS', 'Verhindert blockierende Räder beim Bremsen.'),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'lbl' }, 'Ideallinie'),
        segmented(
          (['off', 'corners', 'full'] as LineMode[]).map((v) => ({ label: v === 'off' ? 'Aus' : v === 'corners' ? 'Nur Kurven' : 'Vollständig', value: v, disabled: !d.allowed.line.includes(v) })),
          a.line,
          (v) => st.update((x) => (x.assists.line = v)),
        ),
      ),
      yesNo('steering', 'Lenkhilfe', 'Begrenzt den Lenkwinkel auf den Haftgrenzbereich und lenkt bei Übersteuern gegen.'),
      yesNo('brake', 'Bremsassistent', 'Bremst automatisch vor Kurven, wenn du zu schnell bist.'),
      yesNo('autoReset', 'Automatische Rücksetzung', 'Setzt dich zurück, wenn du neben der Strecke stecken bleibst.'),
      yesNo('pitAssist', 'Boxengassen-Assistent', 'Nach dem Box-Ruf (Taste P) fährt das Auto selbstständig durch die Boxengasse zur Box und wieder hinaus.'),
    );
    return panel;
  }

  // ------------------------------------------------------------------ Einstellungen

  settings(back: () => void, inRace = false): void {
    const app = this.app;
    const st = app.settings;
    const s = this.screen(inRace ? 'screen dark' : 'screen dim');
    s.append(this.topbar('Einstellungen', 'Werden automatisch gespeichert', back));
    let tab = 'gameplay';
    const tabs = h('div', { class: 'tabs' });
    const body = h('div', { class: 'form-grid' });
    const tabDefs: [string, string][] = [
      ['gameplay', 'Spiel & Fahrhilfen'],
      ['graphics', 'Grafik'],
      ['audio', 'Audio'],
      ['controls', 'Steuerung'],
      ['camera', 'Kamera'],
    ];
    const renderTabs = () => {
      clear(tabs);
      for (const [id, label] of tabDefs) tabs.appendChild(h('button', { class: tab === id ? 'on' : '', onclick: () => ((tab = id), renderTabs(), renderBody()) }, label));
    };
    const renderBody = () => {
      clear(body);
      app.input.cancelCapture();
      if (tab === 'gameplay') {
        body.append(
          this.difficultyPanel(renderBody),
          this.assistPanel(),
          h(
            'div',
            { class: 'panel' },
            h('h4', null, 'Profil'),
            h(
              'div',
              { class: 'field' },
              h('label', null, 'Spielername (Multiplayer)'),
              h('input', {
                type: 'text',
                maxLength: 16,
                value: st.data.playerName,
                oninput: (e: Event) => st.update((x) => (x.playerName = (e.target as HTMLInputElement).value.slice(0, 16) || 'Spieler')),
              }),
            ),
          ),
        );
      } else if (tab === 'graphics') {
        body.append(
          h(
            'div',
            { class: 'panel' },
            h('h4', null, 'Darstellung'),
            h(
              'div',
              { class: 'field' },
              h('div', { class: 'lbl' }, 'Grafikqualität'),
              segmented(
                [
                  { label: 'Niedrig', value: 'low' as Quality },
                  { label: 'Mittel', value: 'medium' as Quality },
                  { label: 'Hoch', value: 'high' as Quality },
                ],
                st.data.graphics.quality,
                (v) => {
                  st.update((x) => (x.graphics.quality = v));
                  app.applyQuality();
                },
              ),
              h('div', { class: 'hint' }, 'Hoch: Schatten 2048, Bloom, mehr Bäume/Publikum. Niedrig: ohne Schatten, reduzierte Auflösung. Änderungen an der Szene wirken ab dem nächsten Rennen.'),
            ),
            h(
              'div',
              { class: 'field' },
              h('div', { class: 'lbl' }, 'FPS-Anzeige'),
              segmented(
                [
                  { label: 'Aus', value: false },
                  { label: 'Ein', value: true },
                ],
                st.data.graphics.showFps,
                (v) => st.update((x) => (x.graphics.showFps = v)),
              ),
            ),
          ),
        );
      } else if (tab === 'audio') {
        const vol = (key: 'master' | 'engine' | 'ambient' | 'effects', label: string) => {
          const [inp, out] = slider(0, 1, 0.05, st.data.audio[key], (v) => {
            st.update((x) => (x.audio[key] = v));
            app.audio.setVolumes(st.data.audio);
          }, (v) => `${Math.round(v * 100)} %`);
          return h('div', { class: 'field' }, h('div', { class: 'lbl' }, label, out), inp);
        };
        body.append(h('div', { class: 'panel' }, h('h4', null, 'Lautstärke'), vol('master', 'Gesamt'), vol('engine', 'Motor'), vol('ambient', 'Umgebung (Wind, Publikum, Regen)'), vol('effects', 'Effekte (Reifen, Aufprall, Curbs)')));
      } else if (tab === 'controls') {
        const c = st.data.controls;
        const [sIn, sOut] = slider(0.4, 1.6, 0.05, c.steerSensitivity, (v) => st.update((x) => (x.controls.steerSensitivity = v)), (v) => `${Math.round(v * 100)} %`);
        const [lIn, lOut] = slider(1, 2.5, 0.1, c.steerLinearity, (v) => st.update((x) => (x.controls.steerLinearity = v)), (v) => v.toFixed(1));
        const [dIn, dOut] = slider(0, 0.3, 0.01, c.deadzone, (v) => st.update((x) => (x.controls.deadzone = v)), (v) => `${Math.round(v * 100)} %`);
        const binds = h('div', { class: 'binds' });
        const renderBinds = () => {
          clear(binds);
          for (const a of Object.keys(ACTION_LABELS) as Action[]) {
            const keys = st.data.controls.bindings[a];
            const mk = (idx: number) => {
              const b = h('button', { class: 'keycap' }, keys[idx] ? keyLabel(keys[idx]) : '—');
              b.addEventListener('click', () => {
                b.classList.add('listening');
                b.textContent = 'Taste drücken…';
                app.input.captureNextKey((code) => {
                  st.update((x) => {
                    // Taste von anderen Aktionen entfernen
                    for (const other of Object.keys(x.controls.bindings) as Action[]) x.controls.bindings[other] = x.controls.bindings[other].filter((k) => k !== code);
                    const arr = x.controls.bindings[a].slice();
                    arr[idx] = code;
                    x.controls.bindings[a] = arr.filter(Boolean);
                  });
                  renderBinds();
                });
              });
              return b;
            };
            binds.append(h('span', null, ACTION_LABELS[a]), mk(0), mk(1));
          }
        };
        renderBinds();
        body.append(
          h(
            'div',
            { class: 'panel' },
            h('h4', null, 'Lenkung'),
            h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Lenkempfindlichkeit', sOut), sIn, h('div', { class: 'hint' }, 'Tastatur: Lenkgeschwindigkeit · Gamepad: Lenkausschlag')),
            h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Gamepad-Lenkkurve', lOut), lIn),
            h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Gamepad-Totzone', dOut), dIn),
            h(
              'div',
              { class: 'field' },
              h('div', { class: 'lbl' }, 'Vibration'),
              segmented(
                [
                  { label: 'Aus', value: false },
                  { label: 'Ein', value: true },
                ],
                c.vibration,
                (v) => st.update((x) => (x.controls.vibration = v)),
              ),
              h('div', { class: 'hint' }, app.input.canVibrate() ? 'Gamepad mit Vibration erkannt.' : 'Wird nur von Gamepads mit Vibrationsunterstützung genutzt.'),
            ),
          ),
          h(
            'div',
            { class: 'panel' },
            h('h4', null, 'Tastenbelegung'),
            binds,
            h(
              'div',
              { style: 'margin-top:12px' },
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: () => {
                    st.update((x) => (x.controls.bindings = structuredClone(DEFAULT_BINDINGS)));
                    renderBinds();
                  },
                },
                'Standardbelegung',
              ),
            ),
          ),
        );
      } else if (tab === 'camera') {
        const cam = st.data.camera;
        const [fIn, fOut] = slider(45, 90, 1, cam.fov, (v) => {
          st.update((x) => (x.camera.fov = v));
          app.applyRuntimeSettings();
        }, (v) => `${v}°`);
        const sel = h('select', {
          onchange: (e: Event) => {
            st.update((x) => (x.camera.mode = (e.target as HTMLSelectElement).value as typeof x.camera.mode));
            app.applyRuntimeSettings();
          },
        });
        for (const m of CAMERA_MODES) {
          const o = h('option', { value: m.id }, m.name);
          if (m.id === cam.mode) o.selected = true;
          sel.appendChild(o);
        }
        body.append(
          h(
            'div',
            { class: 'panel' },
            h('h4', null, 'Kamera'),
            h('div', { class: 'field' }, h('label', null, 'Standardperspektive'), sel),
            h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Sichtfeld', fOut), fIn),
            h(
              'div',
              { class: 'field' },
              h('div', { class: 'lbl' }, 'Kamerawackeln (Curbs/Aufprall)'),
              segmented(
                [
                  { label: 'Aus', value: false },
                  { label: 'Ein', value: true },
                ],
                cam.shake,
                (v) => {
                  st.update((x) => (x.camera.shake = v));
                  app.applyRuntimeSettings();
                },
              ),
            ),
          ),
        );
      }
      app.applyRuntimeSettings();
    };
    renderTabs();
    renderBody();
    s.append(
      tabs,
      body,
      h(
        'div',
        { class: 'bottombar' },
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              if (window.confirm('Alle Einstellungen auf Standard zurücksetzen?')) {
                st.reset();
                app.audio.setVolumes(st.data.audio);
                app.applyQuality();
                renderBody();
              }
            },
          },
          'Zurücksetzen',
        ),
        h('button', { class: 'btn primary', onclick: back }, 'Fertig'),
      ),
    );
  }

  // ------------------------------------------------------------------ Steuerung

  controlsHelp(onClose?: () => void): void {
    const b = this.app.settings.data.controls.bindings;
    const k = (a: Action) => b[a].map(keyLabel).join(' / ');
    const close = () => {
      bg.remove();
      onClose?.();
    };
    const bg = h(
      'div',
      { class: 'modal-bg' },
      h(
        'div',
        { class: 'modal' },
        h('h2', { class: 'title' }, h('small', null, 'Kurzanleitung'), 'Steuerung'),
        h(
          'div',
          { class: 'controls-grid' },
          ...(
            [
              ['Gas', k('throttle')],
              ['Bremse', k('brake')],
              ['Lenken', `${k('left')} · ${k('right')}`],
              ['Handbremse (Hinterachse)', k('handbrake')],
              ['Hochschalten', k('shiftUp')],
              ['Runterschalten', k('shiftDown')],
              ['Kamera wechseln', k('camera')],
              ['Zurücksetzen', k('reset')],
              ['Rückblick', k('lookBack')],
              ['Box-Ruf (Boxenstopp)', k('pit')],
              ['Pause', k('pause')],
            ] as [string, string][]
          ).map(([l, v]) => h('div', null, h('span', null, l), h('b', null, v))),
        ),
        h('h4', { style: 'margin:14px 0 6px;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;font-size:12px' }, 'Gamepad (Standard-Layout)'),
        h(
          'div',
          { class: 'controls-grid' },
          ...(
            [
              ['Lenken', 'Linker Stick'],
              ['Gas / Bremse', 'RT / LT'],
              ['Schalten', 'RB / LB'],
              ['Handbremse', 'A'],
              ['Rückblick', 'B'],
              ['Zurücksetzen', 'X'],
              ['Kamera', 'Y'],
              ['Box-Ruf', 'Steuerkreuz ↓'],
              ['Pause', 'Start'],
            ] as [string, string][]
          ).map(([l, v]) => h('div', null, h('span', null, l), h('b', null, v))),
        ),
        h('p', { style: 'color:var(--muted);font-size:13px;line-height:1.5' }, 'Tipp: Bremse geradeaus vor der Kurve, lenke dann ein und gib erst am Scheitelpunkt dosiert Gas. Die Tastenbelegung kannst du unter Einstellungen → Steuerung ändern.'),
        h('div', { class: 'bottombar' }, h('button', { class: 'btn primary', onclick: close }, 'Verstanden')),
      ),
    );
    this.overlay.appendChild(bg);
  }

  // ------------------------------------------------------------------ Laden

  loading(trackId: string, label: string): { set(p: number, text?: string): void; done(): void } {
    const def = TRACK_DEFS.find((d) => d.id === trackId)!;
    const tr = getPreviewTrack(trackId);
    const bar = h('i');
    const txt = h('div', { class: 'tip' }, label);
    const el = h(
      'div',
      { class: 'loading' },
      h('div', { class: 'spinner' }),
      h('h2', { class: 'title', style: 'text-align:center' }, h('small', null, `${def.location} · ${def.country}`), def.name),
      h('div', { class: 'outline', html: trackOutlineSVG(tr, '#e9edf3', 4) }),
      h('div', { class: 'bar' }, bar),
      txt,
      h('div', { class: 'tip' }, `Tipp: ${TIPS[Math.floor(Math.random() * TIPS.length)]}`),
    );
    this.overlay.appendChild(el);
    return {
      set: (p, text) => {
        bar.style.width = `${Math.round(p * 100)}%`;
        if (text) txt.textContent = text;
      },
      done: () => el.remove(),
    };
  }

  // ------------------------------------------------------------------ Pause

  pause(opts: { multiplayer: boolean; onResume: () => void; onRestart: () => void; onQuit: () => void; onCompound: (c: Compound) => void; current: Compound; next: Compound; pitRequested: boolean; onPitRequest: () => void }): void {
    const app = this.app;
    const s = this.screen('screen dark');
    const item = (label: string, fn: () => void) => h('button', { class: 'menu-item', onclick: () => (app.click(), fn()) }, label);
    const back = () => this.pause(opts);
    s.append(
      h('h2', { class: 'title' }, h('small', null, opts.multiplayer ? 'Das Rennen läuft weiter' : 'Spiel angehalten'), 'Pause'),
      h(
        'div',
        { class: 'form-grid' },
        h(
          'div',
          { class: 'menu-list', style: 'margin-top:0' },
          item(opts.multiplayer ? 'Weiterfahren' : 'Fortsetzen', opts.onResume),
          opts.multiplayer ? null : item('Neustart', opts.onRestart),
          item('Einstellungen', () => this.settings(back, true)),
          item('Steuerung anzeigen', () => this.controlsHelp()),
          item(opts.multiplayer ? 'Rennen verlassen' : 'Zum Hauptmenü', opts.onQuit),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h4', null, 'Boxenstrategie'),
          h('p', { style: 'color:var(--muted);font-size:13px;margin:0 0 10px' }, `Aktuelle Reifen: ${COMPOUNDS[opts.current].name}. Box-Ruf mit Taste P – oder selbst in die Boxengasse fahren (Tempolimit 80 km/h) und in der markierten Box deines Teams halten.`),
          h(
            'button',
            {
              class: `btn ${opts.pitRequested ? '' : 'primary'}`,
              style: 'margin-bottom:12px',
              onclick: () => {
                opts.onPitRequest();
                this.pause({ ...opts, pitRequested: !opts.pitRequested });
              },
            },
            opts.pitRequested ? 'Boxenstopp absagen' : 'Boxenstopp anfordern (Box-Ruf)',
          ),
          h(
            'div',
            { class: 'field' },
            h('div', { class: 'lbl' }, 'Reifen beim nächsten Stopp'),
            segmented(
              (['soft', 'medium', 'hard', 'inter', 'wet'] as Compound[]).map((c) => ({ label: COMPOUNDS[c].name, value: c })),
              opts.next,
              (v) => opts.onCompound(v),
            ),
          ),
          h('h4', { style: 'margin-top:16px' }, 'Schnellzugriff'),
          h(
            'div',
            { class: 'field' },
            h('div', { class: 'lbl' }, 'Ideallinie'),
            segmented(
              (['off', 'corners', 'full'] as LineMode[]).map((v) => ({ label: v === 'off' ? 'Aus' : v === 'corners' ? 'Kurven' : 'Voll', value: v, disabled: !getDifficulty(app.settings.data.difficulty).allowed.line.includes(v) })),
              app.settings.data.assists.line,
              (v) => {
                app.settings.update((x) => (x.assists.line = v));
                app.applyRuntimeSettings();
              },
            ),
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ Ergebnis

  results(opts: {
    title: string;
    subtitle: string;
    rows: () => ResultRow[];
    playerCarId: number;
    live: boolean;
    showRace: boolean;
    buttons: { label: string; primary?: boolean; fn: () => void }[];
  }): void {
    const s = this.screen('screen dark');
    s.append(h('h2', { class: 'title' }, h('small', null, opts.subtitle), opts.title));
    const tableWrap = h('div', { class: 'panel', style: 'overflow-x:auto' });
    const render = () => {
      clear(tableWrap);
      const rows = opts.rows();
      const t = h(
        'table',
        { class: 'res' },
        h(
          'thead',
          null,
          h('tr', null, h('th', null, 'Pos'), h('th', null, 'Fahrer'), h('th', null, 'Team'), opts.showRace ? h('th', null, 'Runden') : null, h('th', null, opts.showRace ? 'Zeit / Abstand' : 'Zeit'), h('th', null, 'Beste Runde'), opts.showRace ? h('th', null, 'Stopps') : null, opts.showRace ? h('th', null, 'Strafen') : null, h('th', null, 'Status')),
        ),
        h(
          'tbody',
          null,
          rows.map((r) =>
            h(
              'tr',
              { class: r.carId === opts.playerCarId ? 'me' : '' },
              h('td', { class: 'pos' }, String(r.position)),
              h('td', null, h('span', { class: 'teambar', style: `background:${r.team.livery.primary}` }), r.name ? `${r.name} (${r.driver.code})` : r.driver.name),
              h('td', null, r.team.name),
              opts.showRace ? h('td', { class: 'num' }, String(r.laps)) : null,
              h('td', { class: 'num' }, r.gapText + (r.estimated ? ' *' : '')),
              h('td', { class: 'num' }, formatTime(r.bestLap)),
              opts.showRace ? h('td', { class: 'num' }, String(r.pitStops)) : null,
              opts.showRace ? h('td', { class: 'num' }, r.penalty ? `+${r.penalty} s` : '–') : null,
              h('td', null, r.status),
            ),
          ),
        ),
      );
      tableWrap.appendChild(t);
      if (rows.some((r) => r.estimated)) tableWrap.appendChild(h('p', { style: 'color:var(--muted);font-size:12px' }, '* Rennen vorzeitig beendet – Zielzeit anhand des Rückstands hochgerechnet.'));
    };
    render();
    if (opts.live) {
      const iv = window.setInterval(render, 1000);
      this.unsubs.push(() => window.clearInterval(iv));
    }
    s.append(
      tableWrap,
      h('div', { class: 'bottombar' }, opts.buttons.map((b) => h('button', { class: `btn ${b.primary ? 'primary' : ''}`, onclick: () => (this.app.click(), b.fn()) }, b.label))),
    );
  }

  // ------------------------------------------------------------------ Fehler

  error(title: string, message: string, onClose?: () => void): void {
    const bg = h(
      'div',
      { class: 'modal-bg' },
      h(
        'div',
        { class: 'modal' },
        h('h2', { class: 'title' }, h('small', null, 'Fehler'), title),
        h('div', { class: 'error-box' }, message),
        h('div', { class: 'bottombar' }, h('button', { class: 'btn primary', onclick: () => (bg.remove(), onClose?.()) }, 'OK')),
      ),
    );
    this.overlay.appendChild(bg);
  }

  // ------------------------------------------------------------------ Multiplayer

  lobbyConnect(): void {
    const app = this.app;
    const st = app.settings;
    const s = this.screen();
    s.append(this.topbar('Online-Multiplayer', 'Lobby erstellen oder beitreten', () => (app.net.disconnect(), this.main())));
    const status = h('div', { class: 'hint' }, statusText(app.net.status));
    this.unsubs.push(app.net.on('status', (v) => (status.textContent = statusText(v))));
    const nameIn = h('input', { type: 'text', maxLength: 16, value: st.data.playerName }) as HTMLInputElement;
    const urlIn = h('input', { type: 'url', placeholder: 'leer = dieser Server', value: st.data.serverUrl }) as HTMLInputElement;
    const codeIn = h('input', { type: 'text', class: 'code-input', maxLength: 5, placeholder: 'CODE' }) as HTMLInputElement;
    const busy = (b: boolean) => s.querySelectorAll('button').forEach((x) => ((x as HTMLButtonElement).disabled = b));
    const ensure = async (): Promise<boolean> => {
      const name = nameIn.value.trim().slice(0, 16);
      if (!name) {
        this.toast('Bitte einen Namen eingeben', true);
        return false;
      }
      st.update((x) => {
        x.playerName = name;
        x.serverUrl = urlIn.value.trim();
      });
      try {
        await app.net.connect(urlIn.value.trim());
        return true;
      } catch (e) {
        this.error('Keine Verbindung', `${(e as Error).message}. Läuft der Server? Start mit „npm run dev“ (Entwicklung) bzw. „npm start“ nach dem Build. Für Spieler im LAN die Server-Adresse eintragen, z. B. http://192.168.0.10:3000.`);
        return false;
      }
    };
    s.append(
      h(
        'div',
        { class: 'form-grid' },
        h(
          'div',
          { class: 'panel' },
          h('h4', null, 'Verbindung'),
          h('div', { class: 'field' }, h('label', null, 'Dein Name'), nameIn),
          h('div', { class: 'field' }, h('label', null, 'Server-Adresse'), urlIn, h('div', { class: 'hint' }, 'Standard: der Server, von dem das Spiel geladen wurde.')),
          status,
        ),
        h(
          'div',
          { class: 'panel' },
          h('h4', null, 'Neue Lobby'),
          h('p', { style: 'color:var(--muted);font-size:13px;margin:0 0 12px' }, 'Erstelle eine Lobby und teile den Code mit deinen Mitspielern. Als Host wählst du Strecke, Runden und Wetter.'),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: async () => {
                busy(true);
                if (await ensure()) {
                  const r = await app.net.createLobby(st.data.playerName);
                  if (r.ok) this.lobby();
                  else this.error('Lobby konnte nicht erstellt werden', r.error ?? 'Unbekannter Fehler');
                }
                busy(false);
              },
            },
            'Lobby erstellen',
          ),
        ),
        h(
          'div',
          { class: 'panel' },
          h('h4', null, 'Beitreten'),
          h('div', { class: 'field' }, h('label', null, 'Lobby-Code'), codeIn),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: async () => {
                const code = codeIn.value.trim().toUpperCase();
                if (code.length !== 5) return this.toast('Der Code hat 5 Zeichen', true);
                busy(true);
                if (await ensure()) {
                  const r = await app.net.joinLobby(code, st.data.playerName);
                  if (r.ok) this.lobby();
                  else this.error('Beitritt nicht möglich', r.error ?? 'Unbekannter Fehler');
                }
                busy(false);
              },
            },
            'Beitreten',
          ),
        ),
      ),
    );
  }

  lobby(waited = 0): void {
    const app = this.app;
    const net = app.net;
    // Lobbystatus kann kurz nach der Bestätigung eintreffen
    if (!net.lobby) {
      if (waited > 3000 || net.status !== 'online') {
        this.toast('Lobby nicht verfügbar', true);
        this.lobbyConnect();
        return;
      }
      window.setTimeout(() => this.lobby(waited + 100), 100);
      return;
    }
    const s = this.screen();
    const leave = () => {
      net.leaveLobby();
      this.lobbyConnect();
    };
    s.append(this.topbar('Lobby', 'Online-Multiplayer', leave));
    const body = h('div', { class: 'form-grid' });
    s.append(body);
    let lastDriverPicked = '';
    const render = () => {
      const lobby = net.lobby;
      if (!lobby) {
        this.toast('Verbindung zur Lobby verloren', true);
        this.lobbyConnect();
        return;
      }
      clear(body);
      const me = lobby.players.find((p) => p.id === net.id);
      const isHost = lobby.hostId === net.id;
      const def = TRACK_DEFS.find((d) => d.id === lobby.settings.trackId)!;
      // Code + Spieler
      const players = h(
        'table',
        { class: 'res' },
        h('thead', null, h('tr', null, h('th', null, 'Spieler'), h('th', null, 'Fahrer'), h('th', null, 'Ping'), h('th', null, 'Status'))),
        h(
          'tbody',
          null,
          lobby.players.map((p) => {
            const d = p.driverId ? getDriver(p.driverId) : null;
            return h(
              'tr',
              { class: p.id === net.id ? 'me' : '' },
              h('td', null, p.name, p.host ? h('span', { class: 'tag host' }, 'HOST') : null),
              h('td', null, d ? h('span', null, h('span', { class: 'teambar', style: `background:${getTeam(d.teamId).livery.primary}` }), `${d.name}`) : '—'),
              h('td', { class: 'num' }, `${p.ping} ms`),
              h('td', null, p.host ? 'Host' : p.ready ? h('span', { class: 'tag ready' }, 'BEREIT') : 'Wartet'),
            );
          }),
        ),
      );
      body.append(
        h(
          'div',
          { class: 'panel' },
          h('h4', null, 'Lobby-Code'),
          h('div', { class: 'logo', style: 'font-size:54px;letter-spacing:.12em;user-select:text' }, lobby.code),
          h(
            'div',
            { style: 'display:flex;gap:8px;margin:8px 0 14px' },
            h(
              'button',
              {
                class: 'btn small',
                onclick: () => {
                  navigator.clipboard?.writeText(lobby.code).then(
                    () => this.toast('Code kopiert'),
                    () => this.toast('Kopieren nicht möglich', true),
                  );
                },
              },
              'Code kopieren',
            ),
            h('span', { class: 'chip' }, `${lobby.players.length} Spieler · Status: ${statusLabel(lobby.status)}`),
            h('span', { class: 'chip' }, `Ping ${net.ping} ms`),
          ),
          players,
        ),
      );
      // Rennen
      const settingsPanel = h('div', { class: 'panel' }, h('h4', null, 'Rennen'), h('div', { class: 'outline', style: 'height:110px;display:flex;justify-content:center', html: trackOutlineSVG(getPreviewTrack(def.id), '#e9edf3', 3) }));
      if (isHost) {
        const sel = h('select', {
          onchange: (e: Event) => net.setSettings({ ...lobby.settings, trackId: (e.target as HTMLSelectElement).value }),
        });
        for (const t of TRACK_DEFS) {
          const o = h('option', { value: t.id }, `${t.name} (${t.lengthKm.toFixed(3)} km)`);
          if (t.id === def.id) o.selected = true;
          sel.appendChild(o);
        }
        const [lapsIn, lapsOut] = slider(1, 15, 1, lobby.settings.laps, () => undefined, (v) => `${v} Runden`);
        lapsIn.addEventListener('change', () => net.setSettings({ ...lobby.settings, laps: Number(lapsIn.value) }));
        settingsPanel.append(
          h('div', { class: 'field' }, h('label', null, 'Strecke'), sel),
          h('div', { class: 'field' }, h('div', { class: 'lbl' }, 'Runden', lapsOut), lapsIn),
          h(
            'div',
            { class: 'field' },
            h('div', { class: 'lbl' }, 'Wetter'),
            segmented(
              [
                { label: 'Trocken', value: 'dry' },
                { label: 'Regen', value: 'wet' },
              ],
              lobby.settings.weather,
              (v) => net.setSettings({ ...lobby.settings, weather: v as 'dry' | 'wet' }),
            ),
          ),
        );
      } else {
        settingsPanel.append(h('p', null, `${def.name} · ${lobby.settings.laps} Runden · ${lobby.settings.weather === 'dry' ? 'Trocken' : 'Regen'}`), h('p', { class: 'hint' }, 'Der Host legt die Renneinstellungen fest.'));
      }
      body.append(settingsPanel);
      // Fahrer & Bereit
      const taken = new Set(lobby.players.filter((p) => p.id !== net.id && p.driverId).map((p) => p.driverId as string));
      const myDriver = me?.driverId ? getDriver(me.driverId) : null;
      const allReady = lobby.players.filter((p) => !p.host).every((p) => p.ready) && lobby.players.every((p) => p.driverId);
      body.append(
        h(
          'div',
          { class: 'panel' },
          h('h4', null, 'Dein Fahrer'),
          myDriver
            ? h('div', { class: 'driver-card selected', style: 'border:none' }, h('div', { class: 'portrait', html: driverPortraitSVG(myDriver, getTeam(myDriver.teamId)) }), h('div', null, h('div', { class: 'dname' }, myDriver.name), h('div', { class: 'dmeta' }, getTeam(myDriver.teamId).name)))
            : h('p', { class: 'hint' }, 'Noch kein Fahrer gewählt.'),
          h(
            'div',
            { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
            h(
              'button',
              {
                class: 'btn',
                disabled: lobby.status !== 'waiting',
                onclick: () =>
                  this.driverSelect(
                    async () => {
                      const id = app.settings.data.race.driverId;
                      lastDriverPicked = id;
                      const r = await net.setDriver(id);
                      if (!r.ok) this.toast(r.error ?? 'Fahrer nicht verfügbar', true);
                      this.lobby();
                    },
                    { taken, back: () => this.lobby(), title: 'Fahrer für das Online-Rennen' },
                  ),
              },
              'Fahrer wählen',
            ),
            isHost
              ? h(
                  'button',
                  {
                    class: 'btn primary',
                    disabled: !allReady || lobby.status !== 'waiting',
                    title: allReady ? '' : 'Alle Spieler brauchen einen Fahrer und müssen bereit sein',
                    onclick: async () => {
                      const r = await net.startRace();
                      if (!r.ok) this.toast(r.error ?? 'Start nicht möglich', true);
                    },
                  },
                  'Rennen starten',
                )
              : h(
                  'button',
                  {
                    class: `btn ${me?.ready ? '' : 'primary'}`,
                    disabled: !me?.driverId || lobby.status !== 'waiting',
                    onclick: () => net.setReady(!me?.ready),
                  },
                  me?.ready ? 'Nicht bereit' : 'Bereit',
                ),
          ),
          isHost && !allReady ? h('p', { class: 'hint', style: 'margin-top:10px' }, 'Start möglich, sobald alle einen Fahrer gewählt haben und bereit sind.') : null,
          lobby.players.length < 2 ? h('p', { class: 'hint', style: 'margin-top:10px' }, 'Warte auf Mitspieler – teile den Lobby-Code. (Ein Solo-Start ist zum Testen möglich.)') : null,
        ),
      );
      void lastDriverPicked;
    };
    render();
    // Automatisch einen freien Fahrer wählen, falls noch keiner gesetzt ist
    const me0 = net.lobby?.players.find((p) => p.id === net.id);
    if (me0 && !me0.driverId) {
      const taken = new Set(net.lobby!.players.map((p) => p.driverId).filter(Boolean) as string[]);
      const want = app.settings.data.race.driverId;
      const pick = !taken.has(want) ? want : ALL_DRIVERS.find((d) => !taken.has(d.id))?.id;
      if (pick) net.setDriver(pick);
    }
    this.unsubs.push(net.on('lobby', () => render()));
    this.unsubs.push(
      net.on('status', (v) => {
        if (v === 'offline') {
          this.toast('Verbindung zum Server getrennt', true);
          this.lobbyConnect();
        }
      }),
    );
  }
}

function statusText(s: string): string {
  return s === 'online' ? '● Verbunden' : s === 'connecting' ? '◌ Verbinde …' : '○ Nicht verbunden';
}

function statusLabel(s: string): string {
  return ({ waiting: 'Wartet', loading: 'Lädt', countdown: 'Start', racing: 'Rennen', finished: 'Beendet' } as Record<string, string>)[s] ?? s;
}
