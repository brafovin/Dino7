// Einzelspieler-Rennsitzung (DOM-frei): Fahrzeuge, KI, Start-Ampel, Runden, Positionen, Abstände,
// Strafen, Boxenstopps, Zieleinlauf und Ergebnis. Wird vom Spiel und von Headless-Tests genutzt.

import { AIDriver, makeAISkill, type OtherCar } from '../shared/ai';
import { Car, type CarInput, COMPOUNDS, type Compound, emptyInput, makeCarParams, type StepEnv } from '../shared/carPhysics';
import { collideCars, collideWalls, type WallHit } from '../shared/collisions';
import { LapTracker, type LapEvent } from '../shared/lapTracker';
import { clamp, mulberry32 } from '../shared/math';
import { computeRacingLine, computeSpeedProfile, type RaceLineData, type SpeedProfile } from '../shared/racingLine';
import { ALL_DRIVERS, type Driver, getDriver, getTeam, TEAMS, type Team } from '../shared/teams';
import { CURB_WIDTH, Track } from '../shared/track';
import { getTrackDef } from '../shared/trackDefs';
import { getDifficulty, type SessionConfig, toPhysicsAssists } from './config';
import type { ISession } from './ISession';

export type SessionKind = 'race' | 'qualifying' | 'timetrial' | 'practice';
export type Phase = 'grid' | 'countdown' | 'racing' | 'finished';

export interface SessionCar {
  id: number;
  driver: Driver;
  team: Team;
  teamIndex: number;
  car: Car;
  isPlayer: boolean;
  ai: AIDriver | null;
  lap: LapTracker;
  input: CarInput;
  progress: number;
  position: number;
  finished: boolean;
  finishTime: number | null;
  totalTime: number | null;
  gapAhead: number | null;
  gapLeader: number | null;
  penalty: number;
  warnings: number;
  pitStops: number;
  pitTimer: number;
  ghostTimer: number;
  prevS: number;
  /** Interpolationszustand für das Rendering */
  prev: { x: number; y: number; z: number; heading: number };
  markerG: Int32Array;
  markerT: Float64Array;
  lastMarker: number;
  cut: { active: boolean; progress0: number; odo0: number };
  offTimer: number;
  wrongWayTimer: number;
  lapInvalid: boolean;
  dnf: boolean;
  nextCompound: Compound;
  slipstream: number;
  quali: number | null;
  /** Boxenstopp angefordert (Box-Ruf) */
  pitRequest: boolean;
  /** Dauer des laufenden/letzten Stopps (Standzeit) */
  pitDuration: number;
  lastPitStop: number | null;
  /** Bei diesem Durchfahren der Boxengasse bereits bedient */
  pitServed: boolean;
  /** Zielzeit geschätzt (Rennen vorzeitig beendet) */
  estimated?: boolean;
  /** Mehrspieler: Name des Spielers */
  playerName?: string;
}

export type SessionEvent =
  | { type: 'message'; text: string; tone: 'info' | 'warn' | 'bad' | 'good'; carId?: number }
  | { type: 'lap'; carId: number; lap: number; lapTime: number; valid: boolean; best: boolean; personalBest: boolean }
  | { type: 'sector'; carId: number; sector: number; split: number }
  | { type: 'impact'; carId: number; speed: number; x: number; y: number; z: number }
  | { type: 'lights'; count: number }
  | { type: 'go' }
  | { type: 'finish'; carId: number; position: number }
  | { type: 'pit'; carId: number; stage: 'in' | 'out'; duration?: number }
  | { type: 'reset'; carId: number };

export interface ResultRow {
  position: number;
  carId: number;
  driver: Driver;
  team: Team;
  laps: number;
  time: number | null;
  gapText: string;
  bestLap: number | null;
  pitStops: number;
  penalty: number;
  status: 'Im Ziel' | 'Läuft' | 'DNF';
  estimated?: boolean;
  name?: string;
}

const MARKER_SPACING = 25;
const STEP_SUBSTEPS = 2;

export class RaceSession implements ISession {
  readonly localSim = true;
  readonly cfg: SessionConfig;
  readonly kind: SessionKind;
  readonly track: Track;
  readonly line: RaceLineData;
  readonly cars: SessionCar[] = [];
  readonly player: SessionCar;
  /** Profil für Bremsassistent/Ideallinienanzeige des Spielers */
  playerProfile: SpeedProfile;
  phase: Phase = 'grid';
  /** Sitzungszeit (s) */
  time = 0;
  /** Zeitpunkt des Startsignals */
  goTime = 0;
  lights = 0;
  private lightsOutAt = 0;
  private countdownStart = 0;
  readonly events: SessionEvent[] = [];
  /** Führender hat die Zielflagge gesehen */
  chequered = false;
  leaderFinishTime: number | null = null;
  finishOrder: number[] = [];
  readonly totalLaps: number;
  readonly markersPerLap: number;
  private rng: () => number;
  private readonly env: StepEnv;
  bestLapOverall: { carId: number; time: number } | null = null;
  playerFinishedAt: number | null = null;
  readonly lapEvents: LapEvent[] = [];
  qualiResults: ResultRow[] | null = null;
  private wallHit: WallHit = { impact: 0, x: 0, y: 0, z: 0 };
  /** Freies Fahren: keine Ziellogik */
  readonly openEnded: boolean;
  /** Spieler wird nach Zieleinlauf von der KI gesteuert */
  private playerAutopilot: AIDriver | null = null;
  /** Boxengassen-Assistent: steuert den Spieler durch die Boxengasse */
  pitPilot: AIDriver | null = null;
  /** Qualifying: KI-Runden werden im Hintergrund in Zeitscheiben simuliert */
  private qualiQueue: Driver[] = [];
  private qualiRun: { driver: Driver; car: Car; ai: AIDriver; lt: LapTracker; prev: number; t: number } | null = null;
  private readonly qualiTimes = new Map<string, number>();

  constructor(cfg: SessionConfig, kind: SessionKind, gridOrder?: string[]) {
    this.cfg = cfg;
    this.kind = kind;
    this.rng = mulberry32(cfg.seed);
    this.track = new Track(getTrackDef(cfg.trackId));
    this.line = computeRacingLine(this.track);
    this.totalLaps = kind === 'race' ? cfg.laps : kind === 'qualifying' ? 2 : 0;
    this.openEnded = kind === 'timetrial' || kind === 'practice';
    this.markersPerLap = Math.ceil(this.track.length / MARKER_SPACING);
    this.env = { weather: cfg.weather, slipstream: 0, frozen: false, wearScale: cfg.wearScale, fuelUse: kind === 'race' };

    const playerDriver = getDriver(cfg.playerDriverId);
    // Teilnehmerfeld
    let drivers: Driver[] = [playerDriver];
    if (kind === 'race') {
      const others = ALL_DRIVERS.filter((d) => d.id !== playerDriver.id);
      // deterministisch mischen
      for (let i = others.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [others[i], others[j]] = [others[j], others[i]];
      }
      drivers = drivers.concat(others.slice(0, clamp(cfg.aiCount, 0, 21)));
    }
    if (gridOrder) {
      const order = gridOrder.map((id) => drivers.find((d) => d.id === id)).filter((d): d is Driver => !!d);
      for (const d of drivers) if (!order.includes(d)) order.push(d);
      drivers = order;
    } else if (kind === 'race') {
      const rest = drivers.slice(1);
      if (cfg.startMode === 'back') drivers = rest.concat(playerDriver);
      else if (cfg.startMode === 'random' || cfg.startMode === 'qualifying') {
        const pos = Math.floor(this.rng() * drivers.length);
        rest.splice(pos, 0, playerDriver);
        drivers = rest;
      }
    }
    const diff = getDifficulty(cfg.difficulty);
    drivers.forEach((driver, idx) => {
      const team = getTeam(driver.teamId);
      const car = new Car(makeCarParams(team.perf));
      const isPlayer = driver.id === playerDriver.id;
      car.st.compound = cfg.weather === 'wet' ? 'inter' : isPlayer ? cfg.startCompound : this.rng() < 0.5 ? 'medium' : 'soft';
      // Kraftstoff für die Renndistanz (+ Reserve)
      car.st.fuel = kind === 'race' ? Math.min(105, (this.track.length / 1000) * 0.36 * cfg.laps + 1.5) : 12;
      let ai: AIDriver | null = null;
      if (isPlayer) {
        car.assists = toPhysicsAssists(cfg.assists, cfg.difficulty, cfg.transmission === 'auto');
      } else {
        car.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0 };
        const wetF = cfg.weather === 'wet' ? 0.97 + 0.03 * driver.skill.wet : 1;
        const skill = makeAISkill(driver.skill.pace, driver.skill.racecraft * diff.aiRacecraft, driver.skill.consistency, diff.aiGrip * wetF);
        ai = new AIDriver(car, this.track, this.line, skill, cfg.weather, (cfg.seed + idx * 7919) >>> 0);
      }
      const sc: SessionCar = {
        id: idx,
        driver,
        team,
        teamIndex: TEAMS.indexOf(team),
        car,
        isPlayer,
        ai,
        lap: new LapTracker(this.track.length, this.track.sectors[0], this.track.sectors[1]),
        input: emptyInput(),
        progress: 0,
        position: idx + 1,
        finished: false,
        finishTime: null,
        totalTime: null,
        gapAhead: null,
        gapLeader: null,
        penalty: 0,
        warnings: 0,
        pitStops: 0,
        pitTimer: 0,
        ghostTimer: 0,
        prevS: 0,
        prev: { x: 0, y: 0, z: 0, heading: 0 },
        markerG: new Int32Array(this.markersPerLap * 4).fill(-999999),
        markerT: new Float64Array(this.markersPerLap * 4),
        lastMarker: -999999,
        cut: { active: false, progress0: 0, odo0: 0 },
        offTimer: 0,
        wrongWayTimer: 0,
        lapInvalid: false,
        dnf: false,
        nextCompound: cfg.weather === 'wet' ? 'inter' : 'hard',
        slipstream: 0,
        quali: null,
        pitRequest: false,
        pitDuration: 0,
        lastPitStop: null,
        pitServed: false,
      };
      this.cars.push(sc);
    });
    this.player = this.cars.find((c) => c.isPlayer)!;
    this.playerProfile = computeSpeedProfile(this.track, this.line, this.player.car, cfg.weather, 0.9, 0.86);

    // Startaufstellung
    if (kind === 'race') {
      this.cars.forEach((c, k) => {
        const slot = this.track.gridSlot(k);
        c.car.placeAt(this.track, slot.s, slot.d);
        // KI behält zunächst ihre Startspur
        if (c.ai) {
          c.ai.lane = c.ai.laneTarget = slot.d - this.track.raceLine[this.track.indexAt(slot.s)];
          c.ai.laneTimer = 4 + k * 0.15;
        }
      });
      this.phase = 'grid';
    } else {
      // Outlap: kurz vor der Linie starten
      const s = this.track.wrapS(-(this.track.def.pit.entry + 60));
      this.player.car.placeAt(this.track, s, this.track.raceLine[this.track.indexAt(s)] * 0.5);
      this.phase = 'racing';
      this.goTime = 0;
    }
    for (const c of this.cars) {
      c.prevS = c.car.st.s;
      this.savePrev(c);
    }
    if (kind === 'qualifying') this.qualiQueue = ALL_DRIVERS.filter((d) => d.id !== playerDriver.id);
  }

  /** Simuliert KI-Qualifyingrunden schrittweise (Zeitbudget in ms). Gibt true zurück, wenn fertig. */
  advanceQualiSim(budgetMs: number): boolean {
    const t0 = now();
    const diff = getDifficulty(this.cfg.difficulty);
    const env: StepEnv = { weather: this.cfg.weather, slipstream: 0, frozen: false, wearScale: 0, fuelUse: false };
    const dt = 1 / 60;
    while (now() - t0 < budgetMs) {
      if (!this.qualiRun) {
        const d = this.qualiQueue.shift();
        if (!d) return true;
        const team = getTeam(d.teamId);
        const car = new Car(makeCarParams(team.perf));
        car.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0 };
        car.st.fuel = 12;
        car.st.compound = this.cfg.weather === 'wet' ? 'inter' : 'soft';
        const wetF = this.cfg.weather === 'wet' ? 0.97 + 0.03 * d.skill.wet : 1;
        const skill = makeAISkill(d.skill.pace, 0, d.skill.consistency, diff.aiGrip * wetF);
        const ai = new AIDriver(car, this.track, this.line, skill, this.cfg.weather, (this.cfg.seed ^ d.number * 2654435761) >>> 0);
        const s0 = this.track.wrapS(-350);
        car.placeAt(this.track, s0, this.track.raceLine[this.track.indexAt(s0)], 55);
        this.qualiRun = { driver: d, car, ai, lt: new LapTracker(this.track.length, this.track.sectors[0], this.track.sectors[1]), prev: car.st.s, t: 0 };
      }
      const r = this.qualiRun;
      for (let k = 0; k < 30; k++) {
        const inp = r.ai.update(dt, [], 0, true);
        r.car.step(inp, dt / 2, this.track, env);
        collideWalls(r.car, this.track);
        r.car.step(inp, dt / 2, this.track, env);
        collideWalls(r.car, this.track);
        if (r.ai.wantsReset) {
          r.car.placeAt(this.track, r.car.st.s, this.track.raceLine[this.track.indexAt(r.car.st.s)]);
          r.ai.onReset();
          r.lt.invalid = true;
        }
        r.t += dt;
        r.lt.update(r.prev, r.car.st.s, r.t - dt, r.t);
        r.prev = r.car.st.s;
        if (r.lt.completed >= 1 || r.t > 240) {
          const lap = r.lt.lastLap;
          // ungültige oder fehlende Runde: Ersatzwert aus dem Geschwindigkeitsprofil
          this.qualiTimes.set(r.driver.id, lap !== null && !r.lt.invalid ? lap : r.ai.profile.lapTime * 1.04);
          this.qualiRun = null;
          break;
        }
      }
    }
    return false;
  }

  /** Startet die Ampelsequenz (Rennen). */
  startCountdown(): void {
    if (this.kind !== 'race' || this.phase !== 'grid') return;
    this.phase = 'countdown';
    this.countdownStart = this.time;
    this.lights = 0;
    this.lightsOutAt = this.time + 5 + 0.6 + this.rng() * 2.2;
  }

  private savePrev(c: SessionCar): void {
    const st = c.car.st;
    c.prev.x = st.x;
    c.prev.y = st.y;
    c.prev.z = st.z;
    c.prev.heading = st.heading;
  }

  private emit(e: SessionEvent): void {
    this.events.push(e);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  /** Spieler-Fahrzeug zurück auf die Strecke setzen. */
  resetCar(c: SessionCar, back = 12): void {
    const tr = this.track;
    let s = tr.wrapS(c.car.st.s - back);
    // Freien Platz suchen
    for (let tries = 0; tries < 12; tries++) {
      const occupied = this.cars.some((o) => o !== c && Math.abs(tr.deltaS(s, o.car.st.s)) < 12 && Math.abs(tr.raceLine[tr.indexAt(s)] - o.car.st.d) < 3);
      if (!occupied) break;
      s = tr.wrapS(s - 15);
    }
    const lapBefore = c.lap.completed;
    c.car.placeAt(tr, s, tr.raceLine[tr.indexAt(s)]);
    c.car.st.compound = c.car.st.compound;
    c.lap.completed = lapBefore;
    c.prevS = c.car.st.s;
    c.ghostTimer = 2.5;
    c.offTimer = 0;
    c.wrongWayTimer = 0;
    c.cut.active = false;
    if (c.ai) c.ai.onReset();
    if (c.isPlayer && this.pitPilot) this.pitPilot = null;
    if (this.openEnded || this.kind === 'qualifying') c.lap.invalid = true;
    this.savePrev(c);
    this.emit({ type: 'reset', carId: c.id });
  }

  /** Ein fester Simulationsschritt. playerInput wird für das Spielerfahrzeug verwendet. */
  step(dt: number, playerInput: CarInput): void {
    const tr = this.track;
    const t0 = this.time;
    this.time += dt;
    const t1 = this.time;

    // ---------------------------------------------- Startsequenz
    if (this.phase === 'countdown') {
      const el = this.time - this.countdownStart;
      const n = Math.min(5, Math.floor(el));
      if (n !== this.lights && this.time < this.lightsOutAt) {
        this.lights = n;
        this.emit({ type: 'lights', count: n });
      }
      if (this.time >= this.lightsOutAt) {
        this.phase = 'racing';
        this.lights = 0;
        this.goTime = this.lightsOutAt;
        for (const c of this.cars) c.lap.startRace(this.goTime);
        this.emit({ type: 'go' });
      }
    }
    const frozen = this.phase === 'grid' || this.phase === 'countdown';
    const raceOn = !frozen;

    // ---------------------------------------------- Eingaben
    const others: OtherCar[] = this.cars.map((c) => ({ car: c.car, id: c.id, ghost: c.ghostTimer > 0 || c.pitTimer > 0 }));
    for (const c of this.cars) {
      this.savePrev(c);
      if (c.isPlayer && this.pitPilot && !this.playerAutopilot) {
        c.input = this.pitPilot.update(dt, others, c.id, raceOn);
      } else if (c.isPlayer && !this.playerAutopilot) {
        c.input = this.applyPlayerAssists(c, playerInput);
      } else {
        const ai = c.isPlayer ? this.playerAutopilot! : c.ai!;
        c.input = ai.update(dt, others, c.id, raceOn);
      }
    }

    // ---------------------------------------------- Windschatten
    for (const c of this.cars) {
      let best = 0;
      for (const o of this.cars) {
        if (o === c) continue;
        const ds = tr.deltaS(c.car.st.s, o.car.st.s);
        if (ds < 6 || ds > 50) continue;
        if (Math.abs(o.car.st.d - c.car.st.d) > 2.4) continue;
        best = Math.max(best, 1 - (ds - 6) / 44);
      }
      c.slipstream = best;
    }

    // ---------------------------------------------- Physik
    const h = dt / STEP_SUBSTEPS;
    for (let sub = 0; sub < STEP_SUBSTEPS; sub++) {
      for (const c of this.cars) {
        const env = this.env;
        env.frozen = frozen || c.pitTimer > 0;
        env.slipstream = c.slipstream;
        c.car.st.impact = 0;
        c.car.step(c.input, h, tr, env);
        const imp = collideWalls(c.car, tr, this.wallHit);
        if (imp > 3) this.emit({ type: 'impact', carId: c.id, speed: imp, x: this.wallHit.x, y: this.wallHit.y, z: this.wallHit.z });
      }
      // Fahrzeug gegen Fahrzeug (nur nahe Paare)
      for (let i = 0; i < this.cars.length; i++) {
        const a = this.cars[i];
        if (a.ghostTimer > 0 || a.pitTimer > 0) continue;
        for (let j = i + 1; j < this.cars.length; j++) {
          const b = this.cars[j];
          if (b.ghostTimer > 0 || b.pitTimer > 0) continue;
          const dx = a.car.st.x - b.car.st.x;
          const dz = a.car.st.z - b.car.st.z;
          if (dx * dx + dz * dz > 49) continue;
          const imp = collideCars(a.car, b.car);
          if (imp > 2) {
            this.emit({ type: 'impact', carId: a.id, speed: imp, x: (a.car.st.x + b.car.st.x) / 2, y: a.car.st.y + 0.4, z: (a.car.st.z + b.car.st.z) / 2 });
          }
        }
      }
    }

    // ---------------------------------------------- Rennlogik je Fahrzeug
    for (const c of this.cars) {
      const st = c.car.st;
      if (c.ghostTimer > 0) c.ghostTimer -= dt;
      if (raceOn && !c.finished) {
        this.lapEvents.length = 0;
        c.lap.update(c.prevS, st.s, t0, t1, this.lapEvents);
        for (const ev of this.lapEvents) this.handleLapEvent(c, ev);
      }
      c.prevS = st.s;
      c.progress = c.lap.progress(st.s);
      if (c.ai) c.ai.firstLap = this.kind === 'race' && c.lap.completed < 1;
      if (raceOn) {
        this.updateMarkers(c, t0, t1);
        this.updateTrackLimits(c);
        this.updatePit(c, dt);
        this.updateResets(c, dt);
      }
    }

    if (this.kind === 'race') this.updatePositions();
    else this.player.position = 1;
    if (this.kind === 'qualifying' && (this.qualiRun || this.qualiQueue.length)) this.advanceQualiSim(0.4);

    // Ende der Sitzung
    if (this.kind === 'race' && this.phase === 'racing') {
      const allDone = this.cars.every((c) => c.finished || c.dnf);
      const timeout = this.leaderFinishTime !== null && this.time - this.leaderFinishTime > 150;
      if (allDone || timeout) this.finishSession();
    }
    if (this.kind === 'qualifying' && this.phase === 'racing' && this.player.lap.completed >= this.totalLaps) {
      this.finishSession();
    }
  }

  /** Brems- und Lenkhilfen, die Streckenwissen benötigen (Spieler). */
  private applyPlayerAssists(c: SessionCar, raw: CarInput): CarInput {
    const out = c.input;
    out.throttle = raw.throttle;
    out.brake = raw.brake;
    out.steer = raw.steer;
    out.steerAngle = raw.steerAngle;
    out.handbrake = raw.handbrake;
    out.shiftUp = raw.shiftUp;
    out.shiftDown = raw.shiftDown;
    if (this.cfg.assists.brake && this.phase === 'racing') {
      const st = c.car.st;
      const v = st.vx;
      const onLine = Math.abs(st.d - this.track.raceLine[this.track.indexAt(st.s)]) < 5;
      const vT = this.track.sampleField(this.playerProfile.v, st.s + v * 0.2);
      if (onLine && v > vT + 1.5) {
        out.brake = Math.max(out.brake, clamp((v - vT) * 0.22, 0, 1));
        out.throttle = Math.min(out.throttle, 0.1);
      }
    }
    return out;
  }

  private handleLapEvent(c: SessionCar, ev: LapEvent): void {
    if (ev.type === 'sector') {
      this.emit({ type: 'sector', carId: c.id, sector: ev.sector, split: ev.split });
      return;
    }
    if (ev.type !== 'lap') return;
    const valid = ev.valid && !c.lapInvalid;
    if (!valid && c.lap.bestLap === ev.lapTime) {
      // ungültige Runde nicht als Bestzeit werten
      const valids = c.lap.lapTimes.filter((_, i) => i !== c.lap.lapTimes.length - 1);
      c.lap.bestLap = valids.length ? Math.min(...valids) : null;
    }
    c.lapInvalid = false;
    let best = false;
    if (valid && (!this.bestLapOverall || ev.lapTime < this.bestLapOverall.time)) {
      this.bestLapOverall = { carId: c.id, time: ev.lapTime };
      best = true;
    }
    const personalBest = valid && c.lap.bestLap === ev.lapTime;
    this.emit({ type: 'lap', carId: c.id, lap: ev.lap, lapTime: ev.lapTime, valid, best, personalBest });
    if (this.kind === 'qualifying' && valid && (c.quali === null || ev.lapTime < c.quali)) c.quali = ev.lapTime;
    // Zielflagge
    if (this.kind === 'race') {
      if (!this.chequered && c.lap.completed >= this.totalLaps) {
        this.chequered = true;
        this.leaderFinishTime = ev.time;
        this.emit({ type: 'message', text: 'Zielflagge!', tone: 'good' });
      }
      if (this.chequered && !c.finished) {
        c.finished = true;
        c.finishTime = ev.time - this.goTime;
        c.totalTime = c.finishTime + c.penalty;
        this.finishOrder.push(c.id);
        const pos = this.finishOrder.length;
        this.emit({ type: 'finish', carId: c.id, position: pos });
        if (c.isPlayer) {
          this.playerFinishedAt = this.time;
          // Auslaufrunde mit KI
          this.playerAutopilot = new AIDriver(c.car, this.track, this.line, { grip: 0.75, brake: 0.75, racecraft: 0, consistency: 1 }, this.cfg.weather, 99);
          c.car.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0.5 };
        }
      }
    }
  }

  private updateMarkers(c: SessionCar, t0: number, t1: number): void {
    const g = Math.floor(c.progress / MARKER_SPACING);
    if (g <= c.lastMarker) return;
    const R = c.markerG.length;
    // Alle übersprungenen Marker interpolieren
    const from = Math.max(c.lastMarker + 1, g - 3);
    for (let k = from; k <= g; k++) {
      const idx = ((k % R) + R) % R;
      c.markerG[idx] = k;
      c.markerT[idx] = k === g ? t1 : t0 + ((k - from + 1) / (g - from + 1)) * (t1 - t0);
    }
    c.lastMarker = g;
  }

  private markerTime(c: SessionCar, g: number): number | null {
    const R = c.markerG.length;
    const idx = ((g % R) + R) % R;
    return c.markerG[idx] === g ? c.markerT[idx] : null;
  }

  private updatePositions(): void {
    const sorted = this.cars.slice().sort((a, b) => {
      if (a.finished && b.finished) return this.finishOrder.indexOf(a.id) - this.finishOrder.indexOf(b.id);
      if (a.finished) return -1;
      if (b.finished) return 1;
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      return b.progress - a.progress;
    });
    const L = this.track.length;
    sorted.forEach((c, i) => {
      c.position = i + 1;
      if (i === 0) {
        c.gapAhead = null;
        c.gapLeader = null;
        return;
      }
      const ahead = sorted[i - 1];
      const leader = sorted[0];
      const gap = (o: SessionCar): number | null => {
        if (c.finished && o.finished && c.finishTime !== null && o.finishTime !== null) return c.finishTime - o.finishTime;
        if (o.progress - c.progress > L) return -Math.floor((o.progress - c.progress) / L); // Runden zurück (negativ kodiert)
        const tMine = this.markerTime(c, c.lastMarker);
        const tOther = this.markerTime(o, c.lastMarker);
        if (tMine !== null && tOther !== null) return Math.max(0, tMine - tOther);
        return null;
      };
      c.gapAhead = gap(ahead);
      c.gapLeader = gap(leader);
    });
  }

  private updateTrackLimits(c: SessionCar): void {
    if (c.pitTimer > 0) return;
    const st = c.car.st;
    const tr = this.track;
    const i = tr.indexAt(st.s);
    const hw = tr.halfW[i];
    const left = st.d > 0;
    const curb = left ? tr.curbL[i] : tr.curbR[i];
    const limit = hw + (curb ? CURB_WIDTH : 0) + 1.15;
    const pit = tr.pit;
    const inPitZone = tr.inRange(st.s, pit.sEntry, pit.sExit) && Math.sign(st.d) === pit.side;
    const off = Math.abs(st.d) > limit && !inPitZone;
    if (off && !c.cut.active) {
      c.cut.active = true;
      c.cut.progress0 = c.progress;
      c.cut.odo0 = st.odometer;
      if (this.openEnded || this.kind === 'qualifying') {
        if (!c.lap.invalid && c.lap.timing && c.isPlayer) this.emit({ type: 'message', text: 'Streckenbegrenzung – Runde ungültig', tone: 'bad', carId: c.id });
        c.lap.invalid = true;
      }
    } else if (!off && c.cut.active) {
      c.cut.active = false;
      const gained = c.progress - c.cut.progress0 - (st.odometer - c.cut.odo0) * 0.97;
      if (this.kind === 'race' && c.isPlayer) {
        if (gained > 7) {
          c.penalty += 5;
          this.emit({ type: 'message', text: 'Abkürzung: +5 s Zeitstrafe', tone: 'bad', carId: c.id });
        } else if (gained > 3) {
          c.warnings++;
          if (c.warnings % 3 === 0) {
            c.penalty += 5;
            this.emit({ type: 'message', text: 'Streckenbegrenzung (3×): +5 s Zeitstrafe', tone: 'bad', carId: c.id });
          } else {
            this.emit({ type: 'message', text: `Streckenbegrenzung – Verwarnung ${c.warnings % 3}/3`, tone: 'warn', carId: c.id });
          }
        }
      }
    }
  }

  /** Fahrzeug befindet sich in der Boxengasse (neben der Strecke auf der Boxenseite). */
  inPitLane(c: SessionCar): boolean {
    const st = c.car.st;
    const tr = this.track;
    const pit = tr.pit;
    return tr.inRange(st.s, pit.sEntry, pit.sExit) && Math.sign(st.d) === pit.side && Math.abs(st.d) > tr.sampleField(tr.halfW, st.s) + 1;
  }

  /** Box-Ruf des Spielers umschalten. */
  togglePitRequest(c: SessionCar = this.player): void {
    if (c.pitTimer > 0) return;
    c.pitRequest = !c.pitRequest;
    if (c.isPlayer) {
      this.emit({
        type: 'message',
        text: c.pitRequest ? `Box, Box! Reifen: ${c.nextCompound.toUpperCase()}` : 'Boxenstopp abgesagt',
        tone: c.pitRequest ? 'warn' : 'info',
        carId: c.id,
      });
    }
  }

  /** Box des Teams (s-Position). */
  boxOf(c: SessionCar): number {
    const boxes = this.track.pit.boxes;
    return boxes[c.teamIndex % boxes.length];
  }

  private updatePit(c: SessionCar, dt: number): void {
    const st = c.car.st;
    const tr = this.track;
    const pit = tr.pit;
    const box = this.boxOf(c);
    const inLane = this.inPitLane(c);
    if (!tr.inRange(st.s, pit.sEntry - 10, pit.sExit + 10)) c.pitServed = false;

    // Laufender Stopp
    if (c.pitTimer > 0) {
      c.pitTimer -= dt;
      if (c.pitTimer <= 0) {
        c.pitTimer = 0;
        st.tyreWear = [0, 0, 0, 0];
        st.compound = c.nextCompound;
        c.pitStops++;
        c.pitServed = true;
        c.pitRequest = false;
        c.lastPitStop = c.pitDuration;
        if (c.ai) c.ai.pitBox = null;
        if (c.isPlayer && this.pitPilot) this.pitPilot.pitBox = null;
        this.emit({ type: 'pit', carId: c.id, stage: 'out', duration: c.pitDuration });
        if (c.isPlayer) this.emit({ type: 'message', text: `Standzeit ${c.pitDuration.toFixed(1)} s – ${COMPOUNDS[st.compound].name}`, tone: 'good', carId: c.id });
      }
      return;
    }

    // KI-Strategie
    if (c.ai && this.kind === 'race' && c.ai.pitBox === null && this.cfg.wearScale > 0 && !c.finished && !c.pitServed) {
      const maxWear = Math.max(...st.tyreWear);
      const lapsLeft = this.totalLaps - c.lap.completed;
      if (maxWear > 0.6 && lapsLeft >= 2) {
        c.ai.pitBox = box;
        c.pitRequest = true;
        c.nextCompound = this.cfg.weather === 'wet' ? 'inter' : lapsLeft > 12 ? 'hard' : 'medium';
      }
    }

    // Spieler: Boxengassen-Assistent übernimmt vor der Einfahrt bzw. in der Boxengasse
    if (c.isPlayer && !this.playerAutopilot) {
      const toEntry = tr.deltaS(st.s, pit.sEntry);
      const approaching = c.pitRequest && !c.pitServed && toEntry > 0 && toEntry < 200;
      if (inLane && !c.pitServed) c.pitRequest = true;
      if (this.cfg.assists.pitAssist && !this.pitPilot && (approaching || inLane)) {
        this.pitPilot = new AIDriver(c.car, tr, this.line, { grip: 0.82, brake: 0.8, racecraft: 0, consistency: 1 }, this.cfg.weather, 77);
        this.pitPilot.pitBox = c.pitServed ? null : box;
        this.emit({ type: 'message', text: 'Boxengassen-Assistent übernimmt', tone: 'info', carId: c.id });
      }
      if (this.pitPilot) {
        const inPath = this.pitPilot.inPitPath || inLane;
        // kleine Toleranz hinter der Einfahrt: der Pilot setzt seinen Boxenpfad erst im nächsten Schritt
        const stillApproaching = c.pitRequest && !c.pitServed && toEntry > -40 && toEntry < 220;
        if (!inPath && !stillApproaching && !c.pitTimer) {
          this.pitPilot = null;
          this.emit({ type: 'message', text: 'Boxengasse verlassen – du fährst', tone: 'good', carId: c.id });
        }
      }
    }

    // Stopp in der eigenen Box (nur einmal pro Durchfahrt, nur mit Box-Ruf)
    if (inLane && !c.pitServed && (c.pitRequest || (c.ai && c.ai.pitBox !== null)) && Math.abs(tr.deltaS(st.s, box)) < 6 && st.speed < 1.5 && Math.abs(Math.abs(st.d) - pit.boxLane) < 3.5) {
      c.pitDuration = 2.1 + this.rng() * 0.9;
      c.pitTimer = c.pitDuration;
      this.emit({ type: 'pit', carId: c.id, stage: 'in', duration: c.pitDuration });
      if (c.isPlayer) this.emit({ type: 'message', text: 'Boxenstopp – Reifenwechsel', tone: 'info', carId: c.id });
    }
    // Zu schnell in der Boxengasse (beim Passieren der Tempolimit-Linie)
    if (c.isPlayer && inLane && Math.abs(tr.deltaS(st.s, pit.sWallStart - 40)) < 2.5 && st.vx > pit.speedLimit + 3 && this.kind === 'race' && !this.pitPilot) {
      c.penalty += 5;
      this.emit({ type: 'message', text: 'Zu schnell in der Boxengasse: +5 s', tone: 'bad', carId: c.id });
    }
  }

  private updateResets(c: SessionCar, dt: number): void {
    const st = c.car.st;
    const pilot = c.isPlayer ? this.playerAutopilot : c.ai;
    if (pilot && pilot.wantsReset) {
      this.resetCar(c, 0);
      pilot.onReset();
      return;
    }
    if (c.isPlayer && !this.playerAutopilot && this.cfg.assists.autoReset) {
      const tr = this.track;
      const i = tr.indexAt(st.s);
      const align = Math.sin(st.heading) * tr.tx[i] + Math.cos(st.heading) * tr.tz[i];
      const stuck = (st.offTrack > 0.5 || st.scrape > 0.5) && st.speed < 2.5;
      c.offTimer = stuck ? c.offTimer + dt : 0;
      c.wrongWayTimer = align < -0.3 && st.speed > 1 ? c.wrongWayTimer + dt : Math.max(0, c.wrongWayTimer - dt);
      if (c.offTimer > 2.2 || c.wrongWayTimer > 3.5) {
        this.resetCar(c);
        this.emit({ type: 'message', text: 'Automatisch auf die Strecke zurückgesetzt', tone: 'info', carId: c.id });
      }
    }
  }

  private finishSession(): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    if (this.kind === 'qualifying') this.qualiResults = this.buildQualiResults();
  }

  /** Beendet das Rennen sofort und wertet nicht angekommene Fahrzeuge nach Fortschritt. */
  forceFinish(): void {
    if (this.kind === 'race') {
      const L = this.track.length;
      const leader = this.cars.find((c) => c.position === 1);
      const pace = leader && leader.finishTime ? leader.finishTime / this.totalLaps : 90;
      for (const c of this.cars.slice().sort((a, b) => b.progress - a.progress)) {
        if (c.finished) continue;
        c.finished = true;
        c.estimated = true;
        const remaining = this.totalLaps * L - c.progress;
        const est = (this.time - this.goTime) + (remaining / L) * pace;
        c.finishTime = est;
        c.totalTime = est + c.penalty;
        this.finishOrder.push(c.id);
      }
    }
    this.finishSession();
  }

  /** Ergebnisliste (Rennen). */
  results(): ResultRow[] {
    const L = this.track.length;
    const rows = this.cars.slice();
    // Klassement: Zieleinlauf nach Gesamtzeit inkl. Strafen, sonst nach Fortschritt
    rows.sort((a, b) => {
      const af = a.finished && a.totalTime !== null;
      const bf = b.finished && b.totalTime !== null;
      const lapsA = a.finished ? this.totalLaps : a.lap.completed;
      const lapsB = b.finished ? this.totalLaps : b.lap.completed;
      if (lapsA !== lapsB) return lapsB - lapsA;
      if (af && bf) return (a.totalTime as number) - (b.totalTime as number);
      if (af !== bf) return af ? -1 : 1;
      return b.progress - a.progress;
    });
    const winner = rows[0];
    return rows.map((c, i) => {
      const laps = c.finished ? this.totalLaps : c.lap.completed;
      let gapText = '';
      if (i === 0) gapText = c.totalTime !== null ? fmt(c.totalTime) : 'Läuft';
      else if (c.totalTime !== null && winner.totalTime !== null && laps === this.totalLaps) gapText = `+${(c.totalTime - winner.totalTime).toFixed(3)}`;
      else {
        const down = Math.max(1, Math.round((winner.progress - c.progress) / L));
        gapText = c.finished ? `+${this.totalLaps - laps || down} Rd.` : 'Läuft';
      }
      return {
        position: i + 1,
        carId: c.id,
        driver: c.driver,
        team: c.team,
        laps,
        time: c.totalTime,
        gapText,
        bestLap: c.lap.bestLap,
        pitStops: c.pitStops,
        penalty: c.penalty,
        status: c.dnf ? 'DNF' : c.finished ? 'Im Ziel' : 'Läuft',
        estimated: c.estimated,
      };
    });
  }

  /** Qualifying-Ergebnis: Spielerzeit + simulierte KI-Runden. */
  buildQualiResults(): ResultRow[] {
    // Restliche KI-Runden fertig simulieren (falls der Spieler sehr schnell war)
    while (!this.advanceQualiSim(50)) {
      /* weiter */
    }
    const rows: { driver: Driver; time: number | null; carId: number }[] = [];
    const player = this.player;
    rows.push({ driver: player.driver, time: player.quali, carId: 0 });
    let id = 1;
    for (const d of ALL_DRIVERS) {
      if (d.id === player.driver.id) continue;
      rows.push({ driver: d, time: this.qualiTimes.get(d.id) ?? null, carId: id++ });
    }
    rows.sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9));
    const pole = rows[0].time ?? 0;
    return rows.map((r, i) => ({
      position: i + 1,
      carId: r.carId,
      driver: r.driver,
      team: getTeam(r.driver.teamId),
      laps: 0,
      time: r.time,
      gapText: r.time === null ? 'Keine Zeit' : i === 0 ? fmt(r.time) : `+${(r.time - pole).toFixed(3)}`,
      bestLap: r.time,
      pitStops: 0,
      penalty: 0,
      status: r.time === null ? 'DNF' : 'Im Ziel',
    }));
  }

  /** Ereignisse abholen (und leeren). */
  drainEvents(): SessionEvent[] {
    const e = this.events.slice();
    this.events.length = 0;
    return e;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
