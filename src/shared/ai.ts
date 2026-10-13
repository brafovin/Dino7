// KI-Fahrer: folgt der Ideallinie (Pure Pursuit), hält ein fahrzeugspezifisches Geschwindigkeitsprofil
// ein, reagiert auf Verkehr (Folgen, Ausweichen, Überholen) und fährt bei Bedarf an die Box.
import { type Car, type CarInput, type Weather, emptyInput } from './carPhysics';
import { clamp, mulberry32, smoothstep } from './math';
import { computeSpeedProfile, type RaceLineData, type SpeedProfile } from './racingLine';
import type { Track } from './track';

export interface AISkill {
  /** Anteil der physikalisch möglichen Kurvengeschwindigkeit (Grip-Ausnutzung) */
  grip: number;
  /** Anteil der möglichen Bremsverzögerung */
  brake: number;
  /** Überholbereitschaft 0..1 */
  racecraft: number;
  /** Konstanz 0..1 (weniger Streuung) */
  consistency: number;
}

export interface OtherCar {
  car: Car;
  id: number;
  ghost?: boolean;
}

const tmpPt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

export class AIDriver {
  readonly car: Car;
  readonly track: Track;
  readonly line: RaceLineData;
  skill: AISkill;
  profile!: SpeedProfile;
  lane = 0;
  laneTarget = 0;
  laneTimer = 0;
  stuckTimer = 0;
  wrongWayTimer = 0;
  wantsReset = false;
  /** Boxenstopp angefordert: Ziel-s der Box */
  pitBox: number | null = null;
  /** Fährt gerade durch die Boxengasse */
  inPitPath = false;
  private rng: () => number;
  private paceNoise = 1;
  private noiseTimer = 0;
  private weather: Weather;
  private readonly inp: CarInput = emptyInput();
  /** Zielgeschwindigkeit des letzten Schritts (für Debug/HUD) */
  targetSpeed = 0;
  /** Zeit hinter einem langsameren Auto */
  private blockedTime = 0;
  private blockedByCar = false;
  /** Erste Runde: vorsichtiger, wenig Überholversuche */
  firstLap = true;

  constructor(car: Car, track: Track, line: RaceLineData, skill: AISkill, weather: Weather, seed: number) {
    this.car = car;
    this.track = track;
    this.line = line;
    this.skill = skill;
    this.weather = weather;
    this.rng = mulberry32(seed);
    this.recomputeProfile();
  }

  recomputeProfile(weather: Weather = this.weather): void {
    this.weather = weather;
    this.profile = computeSpeedProfile(this.track, this.line, this.car, weather, this.skill.grip, this.skill.brake);
  }

  /** Zielgeschwindigkeit an Position s (interpoliert). */
  speedAt(s: number): number {
    return this.track.sampleField(this.profile.v, s);
  }

  update(dt: number, others: OtherCar[], selfId: number, raceStarted: boolean): CarInput {
    const car = this.car;
    const st = car.st;
    const tr = this.track;
    const inp = this.inp;
    inp.shiftUp = false;
    inp.shiftDown = false;
    inp.handbrake = 0;
    inp.steer = 0;

    if (!raceStarted) {
      // Startaufstellung: Drehzahl für den Start halten
      inp.throttle = 0.55;
      inp.brake = 0;
      inp.steerAngle = 0;
      return inp;
    }

    // Konstanz: leichte Tempo-Streuung je Abschnitt
    this.noiseTimer -= dt;
    if (this.noiseTimer <= 0) {
      this.noiseTimer = 2 + this.rng() * 3;
      const spread = (1 - this.skill.consistency) * 0.035;
      this.paceNoise = 1 - this.rng() * spread;
    }

    const v = Math.max(0, st.vx);
    const s = st.s;
    const hw = tr.sampleField(tr.halfW, s);

    // ------------------------------------------------ Verkehr
    let speedCap = Infinity;
    // Harte seitliche Grenzen für das Lenkziel (Autos nebeneinander)
    let dMin = -Infinity;
    let dMax = Infinity;
    let ahead: { ds: number; dd: number; o: OtherCar } | null = null;
    this.blockedByCar = false;
    const caution = this.firstLap ? 1.35 : 1;
    for (const o of others) {
      if (o.id === selfId || o.ghost) continue;
      const os = o.car.st;
      const ds = tr.deltaS(s, os.s);
      if (ds < -12 || ds > 90) continue;
      if (Math.abs(os.y - st.y) > 4) continue;
      const dd = os.d - st.d;
      // Nebeneinander: nicht in das andere Auto hineinlenken
      if (Math.abs(ds) < 7.5 && Math.abs(dd) < 4.5) {
        const sepNeed = 2.75;
        if (dd > 0) dMax = Math.min(dMax, os.d - sepNeed);
        else dMin = Math.max(dMin, os.d + sepNeed);
        // Wer hinten liegt und kaum Platz hat, lupft leicht
        if (ds > 0.5 && Math.abs(dd) < 2.4) speedCap = Math.min(speedCap, os.vx - 0.5);
      }
      if (ds > 0) {
        const myPathThere = tr.sampleField(tr.raceLine, os.s) + this.lane;
        const sep = os.d - myPathThere;
        if (Math.abs(sep) < 2.4 || Math.abs(dd) < 2.3) {
          if (!ahead || ds < ahead.ds) ahead = { ds, dd, o };
        }
      }
    }
    if (ahead) {
      const os = ahead.o.car.st;
      const closing = v - os.vx;
      const gap = ahead.ds - 5.7;
      // Kinematischer Sicherheitsabstand: rechtzeitig auf das Tempo des Vordermanns bremsen
      const margin = 3.5 * caution + v * 0.06;
      const vSafe = Math.sqrt(Math.max(0, os.vx * Math.abs(os.vx) + 2 * (16 / caution) * (gap - margin)));
      speedCap = Math.min(speedCap, Math.max(0, vSafe));
      if (gap < 18) this.blockedByCar = true;
      if (closing > 0.5 || gap < 12) this.blockedTime += dt;
      // Überholen versuchen
      const willing = this.firstLap ? 0.25 : 1;
      if (this.laneTimer <= 0 && gap < 40 && (closing > 1.2 || this.blockedTime > 1.5) && this.rng() < (0.02 + this.skill.racecraft * 0.08) * willing) {
        const hwO = tr.sampleField(tr.halfW, os.s);
        const sideL = hwO - os.d; // Platz links vom Gegner
        const sideR = hwO + os.d;
        // Innenseite der nächsten Kurve bevorzugen
        const kAhead = this.line.k[tr.indexAt(os.s + 60)];
        let side = sideL > sideR ? 1 : -1;
        if (Math.abs(kAhead) > 0.006) side = kAhead > 0 ? 1 : -1;
        if ((side > 0 ? sideL : sideR) < 4.5) side = -side;
        if ((side > 0 ? sideL : sideR) >= 4.2) {
          const targetD = os.d + side * 3.4;
          this.laneTarget = clamp(targetD - tr.sampleField(tr.raceLine, os.s), -hw * 2, hw * 2);
          this.laneTimer = 3.5 + this.rng() * 1.5;
          this.blockedTime = 0;
        }
      }
    } else {
      this.blockedTime = Math.max(0, this.blockedTime - dt);
    }
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) this.laneTarget *= Math.exp(-0.8 * dt);
    const kHere = Math.abs(this.line.k[tr.indexAt(s)]);
    const laneRate = kHere > 0.01 ? 0.9 : 2.2;
    this.lane += clamp(this.laneTarget - this.lane, -laneRate * dt, laneRate * dt);

    // ------------------------------------------------ Boxengasse
    let pitMode = false;
    const pit = tr.pit;
    if (this.pitBox !== null) {
      const toEntry = tr.deltaS(s, pit.sEntry);
      if ((toEntry > 0 && toEntry < 260) || this.inPitPath) pitMode = true;
      if (tr.inRange(s, pit.sEntry, pit.sExit) && this.inPitPath === false && toEntry <= 0 && toEntry > -40) this.inPitPath = true;
    }
    if (this.inPitPath && !tr.inRange(s, pit.sEntry - 5, pit.sExit)) {
      this.inPitPath = false;
    }

    // ------------------------------------------------ Lenkung (Pure Pursuit)
    const Ld = clamp(7 + v * 0.36, 9, 40);
    const sT = s + Ld;
    let dT: number;
    if (pitMode) {
      const toEntry = tr.deltaS(s, pit.sEntry);
      if (this.inPitPath || toEntry <= 0) dT = tr.pitPathD(sT, this.pitBox);
      else {
        const w = 1 - smoothstep(10, 160, toEntry);
        dT = tr.sampleField(tr.raceLine, sT) * (1 - w) + pit.side * hw * 0.6 * w;
      }
    } else {
      const lineT = tr.sampleField(tr.raceLine, sT);
      const hwT = tr.sampleField(tr.halfW, sT);
      dT = clamp(lineT + this.lane, -hwT + 1.25, hwT - 1.25);
      if (dMin <= dMax) dT = clamp(dT, dMin, dMax);
      else dT = (dMin + dMax) * 0.5;
      dT = clamp(dT, -hwT + 1.1, hwT - 1.1);
    }
    // Zurück auf die Strecke, falls neben der Strecke
    const offTrack = Math.abs(st.d) > hw + 1.5;
    tr.pointAt(sT, dT, tmpPt);
    const fx = Math.sin(st.heading);
    const fz = Math.cos(st.heading);
    const lx = Math.cos(st.heading);
    const lz = -Math.sin(st.heading);
    const rx = tmpPt.x - st.x;
    const rz = tmpPt.z - st.z;
    const ax = rx * fx + rz * fz;
    const ay = rx * lx + rz * lz;
    const L = car.p.wheelbase;
    let delta = Math.atan2(2 * L * ay, Math.max(1, ax * ax + ay * ay));
    // Gierraten-Dämpfung gegen Pendeln
    const yawRef = (v * Math.tan(st.steer)) / L;
    delta -= clamp((st.yawRate - yawRef) * 0.05, -0.05, 0.05);
    inp.steerAngle = clamp(delta, -car.p.maxLock, car.p.maxLock);

    // ------------------------------------------------ Tempo
    let vT = this.speedAt(s + v * 0.15) * this.paceNoise;
    // Seitlicher Versatz von der Ideallinie kostet Kurventempo
    vT *= 1 - clamp(Math.abs(this.lane) * kHere * 2.2, 0, 0.12);
    vT = Math.min(vT, speedCap);
    if (offTrack) vT = Math.min(vT, 22);
    if (pitMode && (this.inPitPath || tr.deltaS(s, pit.sEntry) < 60)) {
      vT = Math.min(vT, pit.speedLimit - 0.8);
      if (this.pitBox !== null) {
        const toBox = tr.deltaS(s, this.pitBox);
        if (toBox > -3) vT = Math.min(vT, Math.sqrt(2 * 7 * Math.max(0, toBox - 0.5)));
      }
    }
    if (st.limiter) vT = Math.min(vT, pit.speedLimit - 0.8);
    this.targetSpeed = vT;
    const e = vT - v;
    if (e > 0.4) {
      inp.throttle = clamp(0.45 + e * 0.4, 0, 1);
      inp.brake = 0;
    } else if (e < -0.6) {
      inp.throttle = 0;
      inp.brake = clamp(-e * 0.28 + 0.1, 0, 1);
    } else {
      inp.throttle = 0.3;
      inp.brake = 0;
    }
    if (vT < 0.3 && v < 1.5) {
      inp.throttle = 0;
      inp.brake = 1;
    }

    // ------------------------------------------------ Festgefahren / falsche Richtung
    const tIdx = tr.indexAt(s);
    const align = fx * tr.tx[tIdx] + fz * tr.tz[tIdx];
    if (align < -0.2) this.wrongWayTimer += dt;
    else this.wrongWayTimer = 0;
    const wantsMove = vT > 3;
    if (v < 1.2 && wantsMove && !this.blockedByCar) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    if (this.stuckTimer > 2.5 || this.wrongWayTimer > 1.5) {
      this.wantsReset = true;
      this.stuckTimer = 0;
      this.wrongWayTimer = 0;
    }
    return inp;
  }

  /** Nach einem Reset: Spurversatz zurücksetzen. */
  onReset(): void {
    this.lane = 0;
    this.laneTarget = 0;
    this.laneTimer = 0;
    this.wantsReset = false;
  }
}

/** KI-Können aus Fahrerwerten und Schwierigkeitsgrad. */
export function makeAISkill(pace: number, racecraft: number, consistency: number, difficultyGrip: number): AISkill {
  // Fahrer-Tempo 0.95..1.0 -> ±1.5 % Grip
  const p = clamp((pace - 0.975) / 0.025, -1, 1);
  const grip = difficultyGrip * (1 + p * 0.012);
  return { grip, brake: grip * 0.98, racecraft, consistency };
}

