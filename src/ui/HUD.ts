// Renn-HUD (DOM). Wird von Einzelspieler- und Mehrspieler-Sitzungen gespeist.
import { COMPOUNDS, type Compound } from '../shared/carPhysics';
import { formatTime } from '../shared/math';
import { clear, h, setClass, setText } from './dom';
import { type MapDot, Minimap } from './Minimap';
import type { Track } from '../shared/track';

export interface HudStanding {
  id: number;
  position: number;
  code: string;
  color: string;
  gap: string;
  me: boolean;
  pit?: boolean;
}

export type SectorState = 'none' | 'purple' | 'green' | 'yellow';

export interface HudData {
  mode: 'race' | 'qualifying' | 'timetrial' | 'practice' | 'multiplayer';
  lap: number;
  totalLaps: number;
  position: number;
  carCount: number;
  driverName: string;
  teamName: string;
  teamColor: string;
  number: number;
  speedKmh: number;
  gear: number;
  rpm: number;
  maxRpm: number;
  currentLap: number | null;
  lastLap: number | null;
  bestLap: number | null;
  sessionBest: number | null;
  lapInvalid: boolean;
  sectors: { time: number | null; state: SectorState }[];
  delta: number | null;
  gapAhead: string | null;
  gapBehind: string | null;
  standings: HudStanding[];
  tyreWear: number[];
  compound: Compound;
  fuel: number;
  fuelLaps: number | null;
  ers: number;
  ersDeploying: boolean;
  tc: number;
  abs: boolean;
  tcActive: boolean;
  absActive: boolean;
  limiter: boolean;
  autoGear: boolean;
  penalty: number;
  net: { connected: boolean; ping: number; players: number } | null;
  mapDots: MapDot[];
  raceTime: number | null;
  pit: { title: string; detail: string; tone: 'info' | 'warn' | 'good'; progress: number | null } | null;
  /** Bremshinweis: Text, Detail, Fortschritt bis zum Bremspunkt (0..1), dringend = Bremspunkt erreicht */
  brake?: { title: string; detail: string; tone: 'brake' | 'lift'; urgent: boolean; progress: number } | null;
}

const LED_COUNT = 15;

export class HUD {
  readonly root: HTMLDivElement;
  private minimap = new Minimap(170);
  private el: Record<string, HTMLElement> = {};
  private leds: HTMLElement[] = [];
  private towerRows: HTMLElement[] = [];
  private sectorEls: HTMLElement[] = [];
  private tyreEls: HTMLElement[] = [];
  private msgWrap: HTMLDivElement;
  private lightsEl: HTMLDivElement;
  private lightCols: HTMLElement[] = [];
  private bigEl: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private fpsEl: HTMLDivElement;
  private pitEl: HTMLDivElement;
  private pitTitle: HTMLDivElement;
  private pitDetail: HTMLDivElement;
  private pitBar: HTMLElement;
  private brakeEl: HTMLDivElement;
  private brakeTitle: HTMLDivElement;
  private brakeDetail: HTMLDivElement;
  private brakeBar: HTMLElement;
  private lastTower = '';

  constructor(parent: HTMLElement) {
    this.root = h('div', { class: 'hud' });
    // Positionsturm
    const tower = h('div', { class: 'hud-tower box' }, h('div', { class: 'head' }, (this.el.lapLbl = h('span', null, 'Runde')), (this.el.lap = h('span', { class: 'lap' }, '1'))), (this.el.rows = h('div', { class: 'rows' })));
    // Oben Mitte: Zeiten
    const top = h(
      'div',
      { class: 'hud-top' },
      (this.el.timerBox = h('div', { class: 'timer box' }, h('div', { class: 'lbl' }, 'Rundenzeit'), (this.el.timer = h('div', { class: 'val' }, '--:--.---')), (this.el.delta = h('div', { class: 'delta' }, '')))),
      (this.el.sectors = h('div', { class: 'sectors box' })),
    );
    for (let i = 0; i < 3; i++) {
      const s = h('div', null, `S${i + 1}`);
      this.sectorEls.push(s);
      this.el.sectors.appendChild(s);
    }
    // Position + Karte
    const pos = h(
      'div',
      { class: 'hud-pos' },
      (this.el.posBox = h('div', { class: 'posbox box' }, (this.el.pos = h('span', null, 'P1')), (this.el.posOf = h('small', null, '/20')))),
      this.minimap.canvas,
      (this.el.net = h('div', { class: 'hud-net box' })),
    );
    // Fahrer + Zeiten
    const driver = h(
      'div',
      { class: 'hud-driver box' },
      h('div', { class: 'name' }, (this.el.tb = h('span', { class: 'tb' })), h('div', null, (this.el.dname = h('b', null, '')), (this.el.tname = h('small', null, '')))),
      h(
        'div',
        { class: 'times' },
        h('span', null, 'Letzte'),
        (this.el.last = h('span', null, '--')),
        h('span', null, 'Beste'),
        (this.el.best = h('span', null, '--')),
        (this.el.sbLbl = h('span', null, 'Bestzeit')),
        (this.el.sb = h('span', null, '--')),
        (this.el.penLbl = h('span', null, 'Strafen')),
        (this.el.pen = h('span', null, '0 s')),
      ),
    );
    // Armaturen
    const ledWrap = h('div', { class: 'leds' });
    for (let i = 0; i < LED_COUNT; i++) {
      const l = h('i');
      this.leds.push(l);
      ledWrap.appendChild(l);
    }
    const tyres = h('div', { class: 'tyres' });
    for (let i = 0; i < 4; i++) {
      const t = h('i');
      this.tyreEls.push(t);
      tyres.appendChild(t);
    }
    tyres.appendChild((this.el.cmp = h('span', { class: 'cmp' }, 'M')));
    const dash = h(
      'div',
      { class: 'hud-dash box' },
      (this.el.leds = ledWrap),
      h(
        'div',
        { class: 'dash-main' },
        h('div', { class: 'speed' }, (this.el.speed = h('span', null, '0')), h('small', null, 'KM/H')),
        (this.el.gear = h('div', { class: 'gear' }, 'N')),
        h('div', { class: 'rpm' }, (this.el.rpm = h('span', null, '0')), h('small', null, 'U/MIN')),
      ),
      h('div', { class: 'rpmbar' }, (this.el.rpmBar = h('i'))),
      h(
        'div',
        { class: 'dash-sub' },
        tyres,
        h('div', { class: 'meter fuel' }, h('div', { class: 'lbl' }, 'Kraftstoff', (this.el.fuel = h('b', null, ''))), h('div', { class: 'track' }, (this.el.fuelBar = h('i')))),
        h('div', { class: 'meter ers' }, h('div', { class: 'lbl' }, 'ERS', (this.el.ers = h('b', null, ''))), h('div', { class: 'track' }, (this.el.ersBar = h('i')))),
      ),
      (this.el.assists = h('div', { class: 'assist-icons' })),
    );
    // Abstände
    const gaps = h(
      'div',
      { class: 'hud-gaps' },
      (this.el.gapA = h('div', { class: 'box' }, h('div', { class: 'lbl' }, 'Vordermann'), (this.el.gapAv = h('div', { class: 'val' }, '--')))),
      (this.el.gapB = h('div', { class: 'box' }, h('div', { class: 'lbl' }, 'Hintermann'), (this.el.gapBv = h('div', { class: 'val' }, '--')))),
    );
    this.msgWrap = h('div', { class: 'hud-msgs' });
    this.lightsEl = h('div', { class: 'lights', style: 'display:none' });
    for (let i = 0; i < 5; i++) {
      const col = h('div', { class: 'col' }, h('i'), h('i'));
      this.lightCols.push(col);
      this.lightsEl.appendChild(col);
    }
    this.bigEl = h('div', { class: 'hud-center-big', style: 'display:none' });
    this.hintEl = h('div', { class: 'hud-hint', style: 'display:none' });
    this.fpsEl = h('div', { class: 'hud-fps', style: 'display:none' });
    this.pitBar = h('i');
    this.pitEl = h(
      'div',
      { class: 'hud-pit box', style: 'display:none' },
      (this.pitTitle = h('div', { class: 't' })),
      (this.pitDetail = h('div', { class: 'd' })),
      h('div', { class: 'bar' }, this.pitBar),
    );
    this.brakeBar = h('i');
    this.brakeEl = h(
      'div',
      { class: 'hud-brake', style: 'display:none' },
      (this.brakeTitle = h('div', { class: 't' })),
      (this.brakeDetail = h('div', { class: 'd' })),
      h('div', { class: 'bar' }, this.brakeBar),
    );
    this.root.append(tower, top, pos, driver, dash, gaps, this.pitEl, this.brakeEl, this.msgWrap, this.lightsEl, this.bigEl, this.hintEl, this.fpsEl);
    parent.appendChild(this.root);
  }

  setTrack(track: Track): void {
    this.minimap.setTrack(track);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  update(d: HudData): void {
    const el = this.el;
    // Runde / Position
    if (d.mode === 'race' || d.mode === 'multiplayer') {
      setText(el.lapLbl, 'Runde');
      setText(el.lap, `${Math.min(d.lap, d.totalLaps)}`);
      if (!el.lap.querySelector('small')) el.lap.appendChild(h('small', null, ''));
      setText(el.lap.lastChild as HTMLElement, `/${d.totalLaps}`);
      el.posBox.style.display = '';
      setText(el.pos, `P${d.position}`);
      setText(el.posOf, `/${d.carCount}`);
    } else {
      setText(el.lapLbl, d.mode === 'qualifying' ? 'Qualifying' : d.mode === 'timetrial' ? 'Zeitfahren' : 'Training');
      setText(el.lap, `R${d.lap}`);
      el.posBox.style.display = 'none';
    }
    // Turm
    const towerKey = d.standings.map((s) => `${s.id}${s.gap}${s.me}${s.pit}`).join('|');
    if (towerKey !== this.lastTower) {
      this.lastTower = towerKey;
      const rows = el.rows;
      while (this.towerRows.length < d.standings.length) {
        const r = h('div', { class: 'row' }, h('span', { class: 'p' }), h('i', { class: 'tb' }), h('span', { class: 'c' }), h('span', { class: 'g' }));
        this.towerRows.push(r);
        rows.appendChild(r);
      }
      this.towerRows.forEach((r, i) => {
        const s = d.standings[i];
        r.style.display = s ? '' : 'none';
        if (!s) return;
        const [p, tb, c, g] = Array.from(r.children) as HTMLElement[];
        setText(p, String(s.position));
        tb.style.background = s.color;
        setText(c, s.code);
        setText(g, s.pit ? 'BOX' : s.gap);
        setClass(r, 'me', s.me);
        setClass(r, 'pit', !!s.pit);
      });
    }
    // Zeiten
    setText(el.timer, d.currentLap !== null ? formatTime(d.currentLap) : d.raceTime !== null ? formatTime(d.raceTime) : '--:--.---');
    setClass(el.timerBox, 'invalid', d.lapInvalid && d.currentLap !== null);
    if (d.delta !== null) {
      setText(el.delta, `${d.delta < 0 ? '−' : '+'}${Math.abs(d.delta).toFixed(2)}`);
      setClass(el.delta, 'neg', d.delta < 0);
      setClass(el.delta, 'pos', d.delta >= 0);
    } else setText(el.delta, '');
    d.sectors.forEach((s, i) => {
      const e = this.sectorEls[i];
      setText(e, s.time !== null ? s.time.toFixed(3) : `S${i + 1}`);
      setClass(e, 'sec-purple', s.state === 'purple');
      setClass(e, 'sec-green', s.state === 'green');
      setClass(e, 'sec-yellow', s.state === 'yellow');
    });
    setText(el.last, formatTime(d.lastLap));
    setText(el.best, formatTime(d.bestLap));
    setText(el.sbLbl, d.mode === 'timetrial' ? 'Persönl. Rekord' : 'Schnellste');
    setText(el.sb, formatTime(d.sessionBest));
    el.penLbl.style.display = d.penalty > 0 ? '' : 'none';
    el.pen.style.display = d.penalty > 0 ? '' : 'none';
    setText(el.pen, `+${d.penalty} s`);
    // Fahrer
    el.tb.style.background = d.teamColor;
    setText(el.dname, d.driverName);
    setText(el.tname, `${d.teamName} · #${d.number}`);
    // Armaturen
    setText(el.speed, String(Math.round(d.speedKmh)));
    setText(el.gear, d.gear < 0 ? 'R' : d.gear === 0 ? 'N' : String(d.gear));
    setText(el.rpm, String(Math.round(d.rpm / 50) * 50));
    const f = Math.min(1, d.rpm / d.maxRpm);
    el.rpmBar.style.width = `${(f * 100).toFixed(1)}%`;
    const ledStart = 9200;
    const ledEnd = d.maxRpm - 450;
    const lit = Math.round(((d.rpm - ledStart) / (ledEnd - ledStart)) * LED_COUNT);
    const flash = d.rpm >= ledEnd && !d.autoGear;
    setClass(el.leds, 'flash', flash && Math.floor(performance.now() / 90) % 2 === 0);
    this.leds.forEach((l, i) => {
      const on = i < lit;
      setClass(l, 'g', on && i < 5);
      setClass(l, 'r', on && i >= 5 && i < 10);
      setClass(l, 'b', on && i >= 10);
    });
    setClass(el.gear, 'warn', d.rpm > d.maxRpm - 200 && !d.autoGear);
    // Reifen
    d.tyreWear.forEach((w, i) => {
      const hue = Math.max(0, 120 - w * 150);
      this.tyreEls[i].style.background = `hsl(${hue},85%,${w > 0.8 ? 45 : 50}%)`;
      this.tyreEls[i].title = `${Math.round((1 - w) * 100)} %`;
    });
    const cmp = COMPOUNDS[d.compound];
    setText(el.cmp, cmp.short);
    el.cmp.style.borderColor = cmp.color;
    setText(el.fuel, d.fuelLaps !== null ? `${d.fuel.toFixed(1)} kg · ${d.fuelLaps >= 0 ? '+' : ''}${d.fuelLaps.toFixed(1)} Rd.` : `${d.fuel.toFixed(1)} kg`);
    el.fuelBar.style.width = `${Math.min(100, (d.fuel / 105) * 100 * 1.8).toFixed(0)}%`;
    el.fuelBar.style.background = d.fuelLaps !== null && d.fuelLaps < 0 ? 'var(--bad)' : 'var(--warn)';
    setText(el.ers, `${Math.round(d.ers * 100)} %`);
    el.ersBar.style.width = `${(d.ers * 100).toFixed(0)}%`;
    el.ersBar.style.background = d.ersDeploying ? '#7ad0ff' : '#2fa4ff';
    // Fahrhilfen
    const asst = `${d.tc}${d.abs}${d.tcActive}${d.absActive}${d.limiter}${d.autoGear}`;
    if (el.assists.dataset.k !== asst) {
      el.assists.dataset.k = asst;
      clear(el.assists);
      el.assists.append(
        h('span', { class: d.tcActive ? 'lit' : d.tc > 0 ? 'on' : '' }, `TC ${d.tc === 0 ? 'AUS' : d.tc === 1 ? 'NIEDRIG' : 'HOCH'}`),
        h('span', { class: d.absActive ? 'lit' : d.abs ? 'on' : '' }, `ABS ${d.abs ? 'EIN' : 'AUS'}`),
        h('span', { class: 'on' }, d.autoGear ? 'AUTOMATIK' : 'MANUELL'),
      );
      if (d.limiter) el.assists.append(h('span', { class: 'lit' }, 'PIT 80'));
    }
    // Abstände
    const showGaps = d.mode === 'race' || d.mode === 'multiplayer';
    el.gapA.style.display = showGaps && d.gapAhead ? '' : 'none';
    el.gapB.style.display = showGaps && d.gapBehind ? '' : 'none';
    setText(el.gapAv, d.gapAhead ?? '--');
    setText(el.gapBv, d.gapBehind ?? '--');
    // Netz
    if (d.net) {
      el.net.style.display = '';
      const col = !d.net.connected ? 'var(--bad)' : d.net.ping < 80 ? 'var(--good)' : d.net.ping < 160 ? 'var(--warn)' : 'var(--bad)';
      const key = `${d.net.connected}${d.net.ping}${d.net.players}`;
      if (el.net.dataset.k !== key) {
        el.net.dataset.k = key;
        clear(el.net);
        el.net.append(h('span', { class: 'dot', style: `background:${col}` }), d.net.connected ? `Online · ${d.net.ping} ms · ${d.net.players} Spieler` : 'Verbindung getrennt');
      }
    } else el.net.style.display = 'none';
    // Boxen-Panel
    if (d.pit) {
      this.pitEl.style.display = '';
      setText(this.pitTitle, d.pit.title);
      setText(this.pitDetail, d.pit.detail);
      this.pitEl.dataset.tone = d.pit.tone;
      (this.pitBar.parentElement as HTMLElement).style.display = d.pit.progress === null ? 'none' : '';
      if (d.pit.progress !== null) this.pitBar.style.width = `${Math.round(d.pit.progress * 100)}%`;
    } else this.pitEl.style.display = 'none';
    const b = d.brake;
    if (b) {
      this.brakeEl.style.display = '';
      setText(this.brakeTitle, b.title);
      setText(this.brakeDetail, b.detail);
      this.brakeEl.dataset.tone = b.tone;
      setClass(this.brakeEl, 'urgent', b.urgent);
      this.brakeBar.style.width = `${Math.round(b.progress * 100)}%`;
    } else this.brakeEl.style.display = 'none';
    this.minimap.draw(d.mapDots);
  }

  /** Startampel: n = 0..5 leuchtende Säulen, -1 = ausblenden. */
  setLights(n: number): void {
    if (n < 0) {
      this.lightsEl.style.display = 'none';
      return;
    }
    this.lightsEl.style.display = '';
    this.lightCols.forEach((c, i) => c.querySelectorAll('i').forEach((l) => setClass(l as HTMLElement, 'on', i < n)));
  }

  message(text: string, tone: 'info' | 'warn' | 'bad' | 'good' | 'purple' = 'info', ms = 2600): void {
    const m = h('div', { class: `hud-msg ${tone}` }, text);
    this.msgWrap.appendChild(m);
    while (this.msgWrap.children.length > 3) this.msgWrap.firstChild?.remove();
    window.setTimeout(() => m.remove(), ms);
  }

  big(text: string | null, ms = 0): void {
    if (!text) {
      this.bigEl.style.display = 'none';
      return;
    }
    this.bigEl.textContent = text;
    this.bigEl.style.display = '';
    if (ms) window.setTimeout(() => (this.bigEl.style.display = 'none'), ms);
  }

  hint(text: string | null): void {
    this.hintEl.style.display = text ? '' : 'none';
    if (text) setText(this.hintEl, text);
  }

  fps(text: string | null): void {
    this.fpsEl.style.display = text ? '' : 'none';
    if (text) setText(this.fpsEl, text);
  }

  dispose(): void {
    this.root.remove();
  }
}
