// Mehrspieler-Sitzung auf dem Client: eigenes Auto lokal simuliert, Mitspieler interpoliert,
// Positionen/Runden/Ergebnis vom Server.
import { AIDriver } from '../shared/ai';
import { Car, type CarInput, emptyInput, makeCarParams, type StepEnv } from '../shared/carPhysics';
import { collideCars, collideWalls, type WallHit } from '../shared/collisions';
import { LapTracker } from '../shared/lapTracker';
import { clamp, wrapAngle } from '../shared/math';
import type { CountdownMsg, RaceLoadMsg, ResultsMsg, SnapshotCar, SnapshotMsg } from '../shared/protocol';
import { STATE_HZ } from '../shared/protocol';
import { computeRacingLine, computeSpeedProfile, type RaceLineData, type SpeedProfile } from '../shared/racingLine';
import { getDriver, getTeam, TEAMS } from '../shared/teams';
import { Track } from '../shared/track';
import { getTrackDef } from '../shared/trackDefs';
import { type SessionConfig, toPhysicsAssists } from '../sim/config';
import type { ISession } from '../sim/ISession';
import type { Phase, ResultRow, SessionCar, SessionEvent } from '../sim/RaceSession';
import type { NetClient } from './NetClient';

const INTERP_DELAY = 110;

interface Remote {
  id: string;
  sc: SessionCar;
  buf: { t: number; c: SnapshotCar }[];
}

export class NetRaceSession implements ISession {
  readonly kind = 'multiplayer' as const;
  readonly cfg: SessionConfig;
  readonly track: Track;
  readonly line: RaceLineData;
  readonly cars: SessionCar[] = [];
  readonly player: SessionCar;
  playerProfile: SpeedProfile;
  phase: Phase = 'grid';
  time = 0;
  goTime = 0;
  lights = 0;
  readonly totalLaps: number;
  bestLapOverall: { carId: number; time: number } | null = null;
  readonly openEnded = false;
  readonly localSim = false;
  playerFinishedAt: number | null = null;
  qualiResults: ResultRow[] | null = null;
  private readonly net: NetClient;
  private readonly load: RaceLoadMsg;
  private remotes = new Map<string, Remote>();
  private idToCar = new Map<string, SessionCar>();
  private countdown: CountdownMsg | null = null;
  private events: SessionEvent[] = [];
  private sendTimer = 0;
  private seq = 0;
  private finalRows: ResultRow[] | null = null;
  private env: StepEnv;
  private unsub: (() => void)[] = [];
  private wallHit: WallHit = { impact: 0, x: 0, y: 0, z: 0 };
  private autopilot: AIDriver | null = null;
  private latestStandings: SnapshotMsg['standings'] = [];
  playerNames = new Map<string, string>();

  constructor(cfg: SessionConfig, load: RaceLoadMsg, net: NetClient) {
    this.cfg = cfg;
    this.net = net;
    this.load = load;
    this.track = new Track(getTrackDef(load.trackId));
    this.line = computeRacingLine(this.track);
    this.totalLaps = load.laps;
    this.env = { weather: load.weather, slipstream: 0, frozen: true, wearScale: 1, fuelUse: true };
    let player: SessionCar | null = null;
    load.grid.forEach((g, k) => {
      const driver = getDriver(g.driverId);
      const team = getTeam(driver.teamId);
      const car = new Car(makeCarParams(team.perf));
      car.st.compound = load.weather === 'wet' ? 'inter' : 'medium';
      car.st.fuel = Math.min(105, (this.track.length / 1000) * 0.36 * load.laps + 1.5);
      const slot = this.track.gridSlot(g.slot);
      car.placeAt(this.track, slot.s, slot.d);
      const isPlayer = g.id === net.id;
      if (isPlayer) car.assists = toPhysicsAssists(cfg.assists, cfg.difficulty, cfg.transmission === 'auto');
      const sc: SessionCar = {
        id: k,
        driver,
        team,
        teamIndex: TEAMS.indexOf(team),
        car,
        isPlayer,
        ai: null,
        lap: new LapTracker(this.track.length, this.track.sectors[0], this.track.sectors[1]),
        input: emptyInput(),
        progress: 0,
        position: k + 1,
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
        prevS: car.st.s,
        prev: { x: car.st.x, y: car.st.y, z: car.st.z, heading: car.st.heading },
        markerG: new Int32Array(1),
        markerT: new Float64Array(1),
        lastMarker: 0,
        cut: { active: false, progress0: 0, odo0: 0 },
        offTimer: 0,
        wrongWayTimer: 0,
        lapInvalid: false,
        dnf: false,
        nextCompound: 'hard',
        slipstream: 0,
        quali: null,
        playerName: g.name,
      };
      this.cars.push(sc);
      this.idToCar.set(g.id, sc);
      this.playerNames.set(g.id, g.name);
      if (isPlayer) player = sc;
      else this.remotes.set(g.id, { id: g.id, sc, buf: [] });
    });
    if (!player) throw new Error('Eigener Startplatz fehlt im Rennen');
    this.player = player;
    this.playerProfile = computeSpeedProfile(this.track, this.line, this.player.car, load.weather, 0.9, 0.86);
    this.unsub.push(
      net.on('countdown', (m) => {
        if (m.raceId !== load.raceId) return;
        this.countdown = m;
        this.phase = 'countdown';
      }),
      net.on('snapshot', (m) => this.onSnapshot(m)),
      net.on('correction', (m) => {
        const st = this.player.car.st;
        st.x = m.x;
        st.z = m.z;
        st.heading = m.h;
        st.vx = 0;
        st.vy = 0;
        st.yawRate = 0;
        st.trackIdx = -1;
        this.player.prevS = this.track.indexAt(0);
        this.events.push({ type: 'message', text: `Server-Korrektur: ${m.reason}`, tone: 'warn', carId: this.player.id });
      }),
      net.on('results', (m) => this.onResults(m)),
      net.on('raceEvent', (e) => {
        const sc = this.idToCar.get(e.id);
        if (e.type === 'lap' && sc && e.lapTime !== undefined) {
          if (!this.bestLapOverall || e.lapTime < this.bestLapOverall.time) {
            this.bestLapOverall = { carId: sc.id, time: e.lapTime };
            if (!sc.isPlayer) this.events.push({ type: 'message', text: `Schnellste Runde: ${e.name}`, tone: 'good' });
          }
        } else if (e.type === 'finish' && sc) {
          this.events.push({ type: 'message', text: `${e.name} im Ziel – P${e.pos}`, tone: e.pos === 1 ? 'good' : 'info' });
        } else if (e.type === 'left') {
          this.events.push({ type: 'message', text: `${e.name} hat das Rennen verlassen`, tone: 'warn' });
          if (sc) sc.dnf = true;
        } else if (e.type === 'dnf') {
          this.events.push({ type: 'message', text: `${e.name} ausgeschieden`, tone: 'warn' });
        }
      }),
    );
    // Startaufstellung: Spieler sofort Position senden
    this.sendState(true);
  }

  private onSnapshot(m: SnapshotMsg): void {
    for (const c of m.cars) {
      const r = this.remotes.get(c.id);
      if (!r) continue;
      r.buf.push({ t: m.t, c });
      if (r.buf.length > 40) r.buf.splice(0, r.buf.length - 40);
    }
    this.latestStandings = m.standings;
    for (const s of m.standings) {
      const sc = this.idToCar.get(s.id);
      if (!sc) continue;
      sc.position = s.pos;
      sc.gapAhead = s.gap;
      sc.dnf = s.dnf;
      if (s.finished && !sc.finished) {
        sc.finished = true;
        if (sc.isPlayer) {
          this.playerFinishedAt = this.time;
          this.autopilot = new AIDriver(sc.car, this.track, this.line, { grip: 0.75, brake: 0.75, racecraft: 0, consistency: 1 }, this.load.weather, 5);
          sc.car.assists = { tc: 2, abs: true, steering: false, autoGear: true, stability: 0.5 };
        }
      }
    }
  }

  private onResults(m: ResultsMsg): void {
    if (m.raceId !== this.load.raceId) return;
    const winner = m.rows[0];
    this.finalRows = m.rows.map((r, i) => {
      const driver = getDriver(r.driverId);
      const sc = this.idToCar.get(r.id);
      return {
        position: r.pos,
        carId: sc ? sc.id : 100 + i,
        driver,
        team: getTeam(driver.teamId),
        laps: r.laps,
        time: r.time,
        gapText: i === 0 ? (r.time !== null ? fmt(r.time) : '--') : r.time !== null && winner.time !== null ? `+${(r.time - winner.time).toFixed(3)}` : r.status,
        bestLap: r.best,
        pitStops: 0,
        penalty: 0,
        status: r.status === 'Im Ziel' ? 'Im Ziel' : 'DNF',
        name: r.name,
      };
    });
    this.phase = 'finished';
  }

  /** Interpoliert die Mitspieler zur Renderzeit. */
  private updateRemotes(): void {
    const renderT = this.net.serverNow() - INTERP_DELAY;
    for (const r of this.remotes.values()) {
      const buf = r.buf;
      if (!buf.length) continue;
      const st = r.sc.car.st;
      let a = buf[0];
      let b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= renderT && buf[i + 1].t >= renderT) {
          a = buf[i];
          b = buf[i + 1];
          break;
        }
      }
      let x: number, z: number, y: number, h: number;
      const ca = a.c;
      const cb = b.c;
      if (renderT >= b.t) {
        // Extrapolation (max. 250 ms)
        const dt = clamp((renderT - b.t) / 1000, 0, 0.25);
        const vxW = Math.sin(cb.h) * cb.vx + Math.cos(cb.h) * cb.vy;
        const vzW = Math.cos(cb.h) * cb.vx - Math.sin(cb.h) * cb.vy;
        x = cb.x + vxW * dt;
        z = cb.z + vzW * dt;
        y = cb.y;
        h = cb.h + cb.yr * dt;
      } else if (a === b || b.t === a.t) {
        x = ca.x;
        y = ca.y;
        z = ca.z;
        h = ca.h;
      } else {
        // Hermite-Interpolation mit Geschwindigkeiten
        const T = (b.t - a.t) / 1000;
        const u = clamp((renderT - a.t) / (b.t - a.t), 0, 1);
        const u2 = u * u;
        const u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1;
        const h10 = u3 - 2 * u2 + u;
        const h01 = -2 * u3 + 3 * u2;
        const h11 = u3 - u2;
        const vax = Math.sin(ca.h) * ca.vx + Math.cos(ca.h) * ca.vy;
        const vaz = Math.cos(ca.h) * ca.vx - Math.sin(ca.h) * ca.vy;
        const vbx = Math.sin(cb.h) * cb.vx + Math.cos(cb.h) * cb.vy;
        const vbz = Math.cos(cb.h) * cb.vx - Math.sin(cb.h) * cb.vy;
        x = h00 * ca.x + h10 * T * vax + h01 * cb.x + h11 * T * vbx;
        z = h00 * ca.z + h10 * T * vaz + h01 * cb.z + h11 * T * vbz;
        y = ca.y + (cb.y - ca.y) * u;
        h = ca.h + wrapAngle(cb.h - ca.h) * u;
      }
      const c = renderT >= b.t ? cb : ca;
      st.x = x;
      st.y = y;
      st.z = z;
      st.heading = h;
      st.vx = c.vx;
      st.vy = c.vy;
      st.yawRate = c.yr;
      st.steer = c.st;
      st.rpm = c.rpm;
      st.gear = c.g;
      st.compound = c.cmp;
      r.sc.input.throttle = c.th;
      r.sc.input.brake = c.br;
      r.sc.prev.x = x;
      r.sc.prev.y = y;
      r.sc.prev.z = z;
      r.sc.prev.heading = h;
      // Raddrehung und Neigung grob nachführen
      for (let i = 0; i < 4; i++) st.wheelRot[i] += (st.vx / 0.36) * (1 / 120);
      const proj = { i: 0, s: 0, d: 0, y: 0, tx: 0, tz: 1, dist2: 0 };
      this.track.project(x, z, st.trackIdx, proj, y);
      st.trackIdx = proj.i;
      st.s = proj.s;
      st.d = proj.d;
      const slope = this.track.sampleField(this.track.slope, proj.s);
      const align = Math.sin(h) * proj.tx + Math.cos(h) * proj.tz;
      st.pitch = Math.atan(slope * align);
      st.roll = this.track.sampleField(this.track.bank, proj.s) * align;
    }
  }

  step(dt: number, input: CarInput): void {
    this.time += dt;
    const now = this.net.serverNow();
    if (this.countdown && this.phase === 'countdown') {
      const el = now - this.countdown.lightsStart;
      this.lights = el < 0 ? 0 : Math.min(5, Math.floor(el / 1000) + 1);
      if (now >= this.countdown.lightsOut) {
        this.phase = 'racing';
        this.lights = 0;
        this.goTime = this.time;
        this.player.lap.startRace(this.time);
        this.events.push({ type: 'go' });
      } else if (this.lights > 0 && this.lights !== (this as unknown as { _l?: number })._l) {
        (this as unknown as { _l?: number })._l = this.lights;
        this.events.push({ type: 'lights', count: this.lights });
      }
    }
    this.updateRemotes();
    const p = this.player;
    const st = p.car.st;
    const p0 = p.prev;
    p0.x = st.x;
    p0.y = st.y;
    p0.z = st.z;
    p0.heading = st.heading;
    const racing = this.phase === 'racing' || this.phase === 'finished';
    this.env.frozen = !racing;
    if (this.autopilot) {
      const others = this.cars.map((c) => ({ car: c.car, id: c.id }));
      p.input = { ...this.autopilot.update(dt, others, p.id, true) };
    } else {
      p.input.throttle = input.throttle;
      p.input.brake = input.brake;
      p.input.steer = input.steer;
      p.input.steerAngle = input.steerAngle;
      p.input.handbrake = input.handbrake;
      p.input.shiftUp = input.shiftUp;
      p.input.shiftDown = input.shiftDown;
    }
    // Windschatten hinter Mitspielern
    let slip = 0;
    for (const r of this.remotes.values()) {
      const ds = this.track.deltaS(st.s, r.sc.car.st.s);
      if (ds > 6 && ds < 50 && Math.abs(r.sc.car.st.d - st.d) < 2.4) slip = Math.max(slip, 1 - (ds - 6) / 44);
    }
    this.env.slipstream = slip;
    const t0 = this.time - dt;
    const h = dt / 2;
    for (let k = 0; k < 2; k++) {
      st.impact = 0;
      p.car.step(p.input, h, this.track, this.env);
      const imp = collideWalls(p.car, this.track, this.wallHit);
      if (imp > 3) this.events.push({ type: 'impact', carId: p.id, speed: imp, x: this.wallHit.x, y: this.wallHit.y, z: this.wallHit.z });
      for (const r of this.remotes.values()) {
        if (r.sc.dnf) continue;
        const ci = collideCars(p.car, r.sc.car, true);
        if (ci > 2) this.events.push({ type: 'impact', carId: p.id, speed: ci, x: (st.x + r.sc.car.st.x) / 2, y: st.y + 0.4, z: (st.z + r.sc.car.st.z) / 2 });
      }
    }
    if (racing && !p.finished) {
      const evs = p.lap.update(p.prevS, st.s, t0, this.time);
      for (const e of evs) {
        if (e.type === 'lap') this.events.push({ type: 'lap', carId: p.id, lap: e.lap, lapTime: e.lapTime, valid: e.valid, best: false, personalBest: p.lap.bestLap === e.lapTime });
        if (e.type === 'sector') this.events.push({ type: 'sector', carId: p.id, sector: e.sector, split: e.split });
      }
    }
    p.prevS = st.s;
    p.progress = p.lap.progress(st.s);
    // Zustand senden
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = 1 / STATE_HZ;
      this.sendState(false);
    }
  }

  private sendState(_force: boolean): void {
    const st = this.player.car.st;
    this.net.sendState({
      seq: this.seq++,
      x: round(st.x, 2),
      y: round(st.y, 2),
      z: round(st.z, 2),
      h: round(st.heading, 4),
      vx: round(clamp(st.vx, -100, 100), 2),
      vy: round(clamp(st.vy, -50, 50), 2),
      yr: round(clamp(st.yawRate, -20, 20), 3),
      st: round(clamp(st.steer, -0.9, 0.9), 3),
      rpm: Math.round(st.rpm),
      g: clamp(st.gear, -1, 8),
      th: round(clamp(this.player.input.throttle, 0, 1), 2),
      br: round(clamp(this.player.input.brake, 0, 1), 2),
      cmp: st.compound,
      pit: false,
    });
  }

  drainEvents(): SessionEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  results(): ResultRow[] {
    if (this.finalRows) return this.finalRows;
    return this.cars
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((c, i) => ({
        position: i + 1,
        carId: c.id,
        driver: c.driver,
        team: c.team,
        laps: c.lap.completed,
        time: null,
        gapText: 'Läuft',
        bestLap: this.latestStandings.find((s) => this.idToCar.get(s.id) === c)?.best ?? null,
        pitStops: 0,
        penalty: 0,
        status: 'Läuft',
        name: c.playerName,
      }));
  }

  startCountdown(): void {
    /* vom Server gesteuert */
  }

  resetCar(c: SessionCar): void {
    if (c !== this.player) return;
    const tr = this.track;
    const s = tr.wrapS(c.car.st.s - 10);
    c.car.placeAt(tr, s, tr.raceLine[tr.indexAt(s)]);
    c.prevS = c.car.st.s;
    this.events.push({ type: 'reset', carId: c.id });
  }

  forceFinish(): void {
    /* Ergebnis kommt vom Server */
  }

  dispose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
  }
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
}
