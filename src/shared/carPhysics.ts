// Fahrzeugphysik eines Formel-Rennwagens (vereinfachtes, aber glaubwürdiges 4-Rad-Modell).
//
// Modell:
//  - Ebenes Starrkörpermodell (Längs-, Quergeschwindigkeit, Gierrate) mit vier Rädern
//  - Reifen: Magic-Formula-ähnliche Seitenkraftkurve, Reibungskreis für kombinierten Schlupf,
//    lastabhängiger Reibwert, Durchdrehen/Blockieren bei zu hoher Längskraftanforderung
//  - Dynamische Radlasten aus Gewicht, Abtrieb (v²), Längs- und Querlastverlagerung,
//    Steigung, Querneigung und Kuppen/Senken
//  - Aerodynamik: Luftwiderstand und Abtrieb ∝ v², Windschatten
//  - Antrieb: Leistungskurve über Drehzahl, 8-Gang-Getriebe, Schaltzeit, Drehzahlbegrenzer,
//    Motorbremse, ERS (Boost/Rekuperation), Kraftstoffverbrauch
//  - Fahrhilfen: Traktionskontrolle, ABS, Lenkhilfe (Schlupfwinkelbegrenzung + Gegenlenken),
//    Stabilitätsassistent (Anfänger), Automatikgetriebe
// Koordinaten: Vorwärts = (sin ψ, cos ψ) in (x, z), links = (cos ψ, -sin ψ). Positive Gierrate = Linkskurve.

import { clamp, saturate, sign } from './math';
import type { TeamPerformance } from './teams';
import {
  SURF_ASPHALT,
  SURF_CURB,
  SURF_GRASS,
  SURF_GRAVEL,
  SURF_PIT,
  SURF_RUNOFF_ASPHALT,
  type Projection,
  type Track,
} from './track';

export const GRAVITY = 9.81;
/** Breitere Hinterreifen: etwas mehr Grip hinten -> stabiles Untersteuern im Grenzbereich */
export const REAR_GRIP = 1.07;
export const AIR_DENSITY = 1.225;

export type Compound = 'soft' | 'medium' | 'hard' | 'inter' | 'wet';
export type Weather = 'dry' | 'wet';

export const COMPOUNDS: Record<Compound, { name: string; short: string; color: string; grip: Record<Weather, number>; wear: Record<Weather, number> }> = {
  soft: { name: 'Soft', short: 'S', color: '#ff3030', grip: { dry: 1.0, wet: 0.6 }, wear: { dry: 1.6, wet: 1.2 } },
  medium: { name: 'Medium', short: 'M', color: '#ffd400', grip: { dry: 0.978, wet: 0.58 }, wear: { dry: 1.0, wet: 0.9 } },
  hard: { name: 'Hard', short: 'H', color: '#f2f2f2', grip: { dry: 0.958, wet: 0.55 }, wear: { dry: 0.65, wet: 0.6 } },
  inter: { name: 'Intermediate', short: 'I', color: '#33c24d', grip: { dry: 0.86, wet: 0.84 }, wear: { dry: 2.6, wet: 0.9 } },
  wet: { name: 'Regen', short: 'W', color: '#2f7dff', grip: { dry: 0.8, wet: 0.88 }, wear: { dry: 3.5, wet: 0.8 } },
};

export const SURFACE_INFO: { grip: number; wetGrip: number; drag: number; bump: number; name: string }[] = [];
SURFACE_INFO[SURF_ASPHALT] = { grip: 1.0, wetGrip: 1.0, drag: 0, bump: 0, name: 'Asphalt' };
SURFACE_INFO[SURF_CURB] = { grip: 0.93, wetGrip: 0.78, drag: 0.01, bump: 1, name: 'Curb' };
SURFACE_INFO[SURF_RUNOFF_ASPHALT] = { grip: 0.94, wetGrip: 0.95, drag: 0.005, bump: 0.15, name: 'Auslauf' };
SURFACE_INFO[SURF_GRASS] = { grip: 0.58, wetGrip: 0.65, drag: 0.07, bump: 0.5, name: 'Gras' };
SURFACE_INFO[SURF_GRAVEL] = { grip: 0.5, wetGrip: 0.9, drag: 0.42, bump: 0.8, name: 'Kies' };
SURFACE_INFO[SURF_PIT] = { grip: 0.98, wetGrip: 1.0, drag: 0, bump: 0, name: 'Boxengasse' };

export interface CarParams {
  mass: number;
  wheelbase: number;
  cgToFront: number;
  cgToRear: number;
  trackWidth: number;
  cgHeight: number;
  izz: number;
  wheelRadius: number;
  cdA: number;
  clA: number;
  aeroFront: number;
  icePower: number;
  ersPower: number;
  ersCapacity: number;
  gearRatios: number[];
  maxRpm: number;
  idleRpm: number;
  launchRpm: number;
  shiftTime: number;
  brakeForceMax: number;
  brakeBias: number;
  mu: number;
  maxLock: number;
  rollFront: number;
  drivetrainEff: number;
  tyreWear: number;
  length: number;
  width: number;
}

export function makeCarParams(perf?: TeamPerformance): CarParams {
  const p = perf ?? { power: 1, downforce: 1, drag: 1, tyreWear: 1 };
  const wheelRadius = 0.36;
  const maxRpm = 13000;
  // Getriebe: 1. Gang ~ 108 km/h, 8. Gang ~ 345 km/h bei Höchstdrehzahl
  const wMax = (maxRpm * 2 * Math.PI) / 60;
  const v1 = 30;
  const v8 = 97;
  const r1 = (wMax * wheelRadius) / v1;
  const r8 = (wMax * wheelRadius) / v8;
  const gearRatios: number[] = [];
  for (let i = 0; i < 8; i++) {
    const t = Math.pow(i / 7, 0.92);
    gearRatios.push(r1 * Math.pow(r8 / r1, t));
  }
  return {
    mass: 800,
    wheelbase: 3.6,
    cgToFront: 1.98,
    cgToRear: 1.62,
    trackWidth: 1.95,
    cgHeight: 0.3,
    izz: 1500,
    wheelRadius,
    cdA: 1.12 * p.drag,
    clA: 4.1 * p.downforce,
    aeroFront: 0.44,
    icePower: 560000 * p.power,
    ersPower: 160000 * p.power,
    ersCapacity: 4.0e6,
    gearRatios,
    maxRpm,
    idleRpm: 4000,
    launchRpm: 9000,
    shiftTime: 0.06,
    brakeForceMax: 46000,
    brakeBias: 0.57,
    mu: 1.78,
    maxLock: 0.42,
    rollFront: 0.53,
    drivetrainEff: 0.94,
    tyreWear: p.tyreWear,
    length: 5.6,
    width: 1.95,
  };
}

/** Normierte Leistungskurve über Drehzahl. */
const POWER_CURVE: [number, number][] = [
  [0, 0.0],
  [3000, 0.18],
  [5000, 0.38],
  [7000, 0.58],
  [9000, 0.78],
  [10500, 0.92],
  [11500, 0.99],
  [12000, 1.0],
  [12600, 0.97],
  [13000, 0.93],
  [14000, 0.8],
];

export function powerFraction(rpm: number): number {
  if (rpm <= 0) return 0;
  for (let i = 1; i < POWER_CURVE.length; i++) {
    if (rpm <= POWER_CURVE[i][0]) {
      const [r0, p0] = POWER_CURVE[i - 1];
      const [r1, p1] = POWER_CURVE[i];
      return p0 + ((p1 - p0) * (rpm - r0)) / (r1 - r0);
    }
  }
  return POWER_CURVE[POWER_CURVE.length - 1][1];
}

// Reifen-Seitenkraftkurve (Magic Formula, normiert)
const MF_B = 18;
const MF_C = 1.6;
const MF_E = 0.3;
export function tyreCurve(alpha: number): number {
  const u = MF_B * alpha;
  return Math.sin(MF_C * Math.atan(u - MF_E * (u - Math.atan(u))));
}
/** Schlupfwinkel bei maximaler Seitenkraft. */
export const ALPHA_PEAK = (() => {
  let best = 0;
  let bestA = 0;
  for (let a = 0.001; a < 0.4; a += 0.0005) {
    const f = tyreCurve(a);
    if (f > best) {
      best = f;
      bestA = a;
    }
  }
  return bestA;
})();

export interface CarInput {
  throttle: number;
  brake: number;
  /** -1 (rechts) .. +1 (links) – normierter Lenkwunsch */
  steer: number;
  /** Optional: absoluter Radlenkwinkel (KI) */
  steerAngle?: number;
  handbrake: number;
  shiftUp: boolean;
  shiftDown: boolean;
}

export const emptyInput = (): CarInput => ({ throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false });

export interface Assists {
  /** 0 = aus, 1 = niedrig, 2 = hoch */
  tc: 0 | 1 | 2;
  abs: boolean;
  steering: boolean;
  autoGear: boolean;
  /** Stabilitätsassistent 0..1 */
  stability: number;
}

export interface StepEnv {
  weather: Weather;
  /** 0..1 Windschatten-Stärke für dieses Fahrzeug */
  slipstream: number;
  /** Fahrzeug darf sich nicht bewegen (Startaufstellung) */
  frozen: boolean;
  /** Reifenverschleiß-Multiplikator (0 = aus) */
  wearScale: number;
  /** Kraftstoffverbrauch aktiv */
  fuelUse: boolean;
}

export class CarState {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  vx = 0;
  vy = 0;
  yawRate = 0;
  steer = 0;
  throttle = 0;
  brake = 0;
  gear = 1;
  rpm = 4000;
  shiftTimer = 0;
  pendingGear = 1;
  ax = 0;
  ay = 0;
  pitch = 0;
  roll = 0;
  bodyPitch = 0;
  bodyRoll = 0;
  bump = 0;
  wheelRot = [0, 0, 0, 0];
  slipAngle = [0, 0, 0, 0];
  slide = [0, 0, 0, 0];
  load = [0, 0, 0, 0];
  surface = [0, 0, 0, 0];
  wheelspin = 0;
  lockup = 0;
  curb = 0;
  offTrack = 0;
  ers = 4.0e6;
  ersDeploying = false;
  fuel = 30;
  tyreWear = [0, 0, 0, 0];
  compound: Compound = 'medium';
  limiter = false;
  overRev = 0;
  tcActive = 0;
  absActive = 0;
  reverseHold = 0;
  // Streckenbezug
  trackIdx = -1;
  s = 0;
  d = 0;
  /** Distanz seit Start (für Kilometerzähler/Statistik) */
  odometer = 0;
  // Kollisionsinfo (vom Kollisionsmodul gesetzt)
  impact = 0;
  scrape = 0;

  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }
}

const tmpProj: Projection = { i: 0, s: 0, d: 0, y: 0, tx: 0, tz: 1, dist2: 0 };

export class Car {
  readonly p: CarParams;
  readonly st = new CarState();
  assists: Assists = { tc: 1, abs: true, steering: false, autoGear: true, stability: 0 };
  /** Grip-Multiplikator (z. B. Fahrerkönnen bei Nässe für KI) */
  gripScale = 1;
  /** Physik-Ereignisse fürs Audio/HUD */
  shiftedThisStep = 0;
  overRevDenied = false;
  private readonly wheelPos: [number, number][];
  private readonly mass0: number;

  constructor(params: CarParams) {
    this.p = params;
    const a = params.cgToFront;
    const b = params.cgToRear;
    const t = params.trackWidth / 2;
    this.wheelPos = [
      [a, t],
      [a, -t],
      [-b, t],
      [-b, -t],
    ];
    this.mass0 = params.mass;
    this.st.ers = params.ersCapacity;
  }

  get mass(): number {
    return this.mass0 + this.st.fuel;
  }

  /** Grip-Faktor eines Reifens (Mischung, Wetter, Verschleiß). */
  tyreGrip(i: number, weather: Weather): number {
    const c = COMPOUNDS[this.st.compound];
    const w = this.st.tyreWear[i];
    const wearF = 1 - 0.07 * w - 0.35 * Math.max(0, w - 0.65) ** 2;
    return c.grip[weather] * wearF;
  }

  /**
   * Geschätzte maximale Querbeschleunigung bei Geschwindigkeit v (für Lenkbegrenzung/KI).
   * Berücksichtigt Abtrieb, lastabhängigen Reibwert und Querlastverlagerung je Achse.
   */
  lateralCapacity(v: number, weather: Weather): number {
    const p = this.p;
    const m = this.mass;
    const L = p.wheelbase;
    const df = 0.5 * AIR_DENSITY * p.clA * v * v;
    const front = (m * GRAVITY * p.cgToRear) / L + df * p.aeroFront;
    const rear = (m * GRAVITY * p.cgToFront) / L + df * (1 - p.aeroFront);
    const g = this.tyreGrip(0, weather) * this.gripScale * p.mu;
    let a = (g * (front + rear)) / m;
    for (let it = 0; it < 4; it++) {
      const dLat = (m * a * p.cgHeight) / p.trackWidth;
      const fo = front / 2 + dLat * p.rollFront;
      const fi = Math.max(0, front / 2 - dLat * p.rollFront);
      const ro = rear / 2 + dLat * (1 - p.rollFront);
      const ri = Math.max(0, rear / 2 - dLat * (1 - p.rollFront));
      const capF = g * (this.loadSens(fo) * fo + this.loadSens(fi) * fi);
      const capR = g * REAR_GRIP * (this.loadSens(ro) * ro + this.loadSens(ri) * ri);
      // Achse muss ihren Anteil der Zentripetalkraft tragen
      const aF = capF / ((m * p.cgToRear) / L);
      const aR = capR / ((m * p.cgToFront) / L);
      a = a * 0.5 + Math.min(aF, aR) * 0.5;
    }
    return a;
  }

  private loadSens(fz: number): number {
    return clamp(1 - 0.11 * (fz / 3200 - 1), 0.72, 1.12);
  }

  /** Maximaler Lenkwinkel für Spielereingaben bei Geschwindigkeit v. */
  maxSteerFor(v: number, weather: Weather): number {
    const p = this.p;
    if (v < 6) return p.maxLock;
    const aLat = this.lateralCapacity(v, weather);
    const geo = (p.wheelbase * aLat) / (v * v);
    const allowance = this.assists.steering ? ALPHA_PEAK * 0.85 : ALPHA_PEAK * 2.2;
    return clamp(geo + allowance, 0.04, p.maxLock);
  }

  rpmForGear(gear: number, vx: number): number {
    if (gear === 0) return 0;
    const ratio = this.p.gearRatios[Math.max(0, Math.abs(gear) - 1)];
    return ((Math.abs(vx) / this.p.wheelRadius) * ratio * 60) / (2 * Math.PI);
  }

  /** Setzt das Fahrzeug an eine Position (Startaufstellung/Reset). */
  placeAt(track: Track, s: number, d: number, speed = 0): void {
    const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
    track.pointAt(s, d, pt);
    const st = this.st;
    st.x = pt.x;
    st.z = pt.z;
    st.y = pt.y;
    st.heading = Math.atan2(pt.tx, pt.tz);
    st.vx = speed;
    st.vy = 0;
    st.yawRate = 0;
    st.steer = 0;
    st.ax = 0;
    st.ay = 0;
    st.trackIdx = track.indexAt(s);
    st.gear = speed > 20 ? 4 : 1;
    st.pendingGear = st.gear;
    st.shiftTimer = 0;
    st.rpm = Math.max(this.p.idleRpm, this.rpmForGear(st.gear, speed));
    track.project(st.x, st.z, st.trackIdx, tmpProj);
    st.s = tmpProj.s;
    st.d = tmpProj.d;
    st.trackIdx = tmpProj.i;
  }

  /** Ein Physik-Zeitschritt. */
  step(inp: CarInput, dt: number, track: Track, env: StepEnv): void {
    const st = this.st;
    const p = this.p;
    const m = this.mass;
    this.shiftedThisStep = 0;
    this.overRevDenied = false;

    // ------------------------------------------------ Streckenbezug & Belag
    track.project(st.x, st.z, st.trackIdx, tmpProj);
    st.trackIdx = tmpProj.i;
    st.s = tmpProj.s;
    st.d = tmpProj.d;
    const fwdX = Math.sin(st.heading);
    const fwdZ = Math.cos(st.heading);
    const leftX = Math.cos(st.heading);
    const leftZ = -Math.sin(st.heading);
    const ttx = tmpProj.tx;
    const ttz = tmpProj.tz;
    const tnx = ttz;
    const tnz = -ttx;
    const wheelH = [0, 0, 0, 0];
    let curb = 0;
    let off = 0;
    let surfDrag = 0;
    let bumpAmt = 0;
    const gripSurf = [1, 1, 1, 1];
    const wet = env.weather === 'wet';
    for (let i = 0; i < 4; i++) {
      const [px, py] = this.wheelPos[i];
      const ox = fwdX * px + leftX * py;
      const oz = fwdZ * px + leftZ * py;
      const sw = st.s + ox * ttx + oz * ttz;
      const dw = st.d + ox * tnx + oz * tnz;
      const surf = track.surfaceAt(sw, dw);
      st.surface[i] = surf;
      const info = SURFACE_INFO[surf];
      gripSurf[i] = wet ? info.grip * info.wetGrip : info.grip;
      surfDrag += info.drag * 0.25;
      bumpAmt += info.bump * 0.25;
      if (surf === SURF_CURB) curb += 0.25;
      if (surf === SURF_GRASS || surf === SURF_GRAVEL) off += 0.25;
      wheelH[i] = track.heightAt(sw, dw) + (surf === SURF_CURB ? 0.035 : 0);
    }
    st.curb = curb;
    st.offTrack = off;
    void SURF_PIT;
    void SURF_RUNOFF_ASPHALT;

    // Oberflächenneigung im Fahrzeugsystem
    const L = p.wheelbase;
    const tw = p.trackWidth;
    const hFront = (wheelH[0] + wheelH[1]) * 0.5;
    const hRear = (wheelH[2] + wheelH[3]) * 0.5;
    const hLeft = (wheelH[0] + wheelH[2]) * 0.5;
    const hRight = (wheelH[1] + wheelH[3]) * 0.5;
    const gradF = (hFront - hRear) / L; // dh/d(vorwärts)
    const gradL = (hLeft - hRight) / tw; // dh/d(links)
    st.y = (hFront * p.cgToRear + hRear * p.cgToFront) / L;
    st.pitch = Math.atan(gradF);
    st.roll = Math.atan(gradL);
    // vertikale Krümmung (Senke = mehr Last)
    const vcurv = track.sampleField(track.vcurv, st.s);
    const alignT = fwdX * ttx + fwdZ * ttz;

    // ------------------------------------------------ Eingaben & Fahrhilfen
    const speed = Math.hypot(st.vx, st.vy);
    let throttleIn = clamp(inp.throttle, 0, 1);
    let brakeIn = clamp(inp.brake, 0, 1);

    // Rückwärtsgang-Logik (Automatik): Bremse im Stand halten
    if (this.assists.autoGear) {
      if (st.gear > 0 && speed < 0.6 && brakeIn > 0.5 && throttleIn < 0.05) {
        st.reverseHold += dt;
        if (st.reverseHold > 0.45) {
          st.gear = -1;
          st.pendingGear = -1;
          st.reverseHold = 0;
        }
      } else if (st.gear < 0 && st.vx > -0.6 && throttleIn > 0.1) {
        st.gear = 1;
        st.pendingGear = 1;
      } else st.reverseHold = 0;
    }
    if (st.gear < 0) {
      // Im Rückwärtsgang: Bremse = Gas (rückwärts), Gas = Bremse
      const t = throttleIn;
      throttleIn = brakeIn;
      brakeIn = t;
    }

    // Lenkung
    let delta: number;
    if (inp.steerAngle !== undefined) {
      delta = clamp(inp.steerAngle, -p.maxLock, p.maxLock);
    } else {
      const lim = this.maxSteerFor(speed, env.weather);
      delta = clamp(inp.steer, -1, 1) * lim;
      if (this.assists.steering && st.vx > 8) {
        // Gegenlenken bei Übersteuern
        const beta = Math.atan2(st.vy, Math.abs(st.vx));
        const rearSlip = Math.atan2(st.vy - st.yawRate * p.cgToRear, Math.abs(st.vx));
        if (Math.abs(rearSlip) > ALPHA_PEAK * 0.8) delta += clamp(rearSlip * 0.9, -0.15, 0.15);
        void beta;
      }
    }
    // Lenkgetriebe-Trägheit
    const steerRate = 4.5;
    st.steer += clamp(delta - st.steer, -steerRate * dt, steerRate * dt);

    // ------------------------------------------------ Getriebe
    this.updateGearbox(inp, dt, throttleIn, brakeIn);

    // ------------------------------------------------ Motor & Antrieb
    const ratio = st.gear === 0 ? 0 : p.gearRatios[Math.abs(st.gear) - 1];
    const wheelRpm = this.rpmForGear(st.gear === 0 ? 1 : st.gear, st.vx);
    let targetRpm: number;
    const shifting = st.shiftTimer > 0;
    // Effektive Motordrehzahl: im 1. Gang/Rückwärts schleift die Kupplung beim Anfahren,
    // in höheren Gängen ist der Motor starr mit den Rädern verbunden (falscher Gang = niedrige Drehzahl).
    let effRpm: number;
    if (env.frozen || st.gear === 0) {
      targetRpm = p.idleRpm + throttleIn * (p.maxRpm - 300 - p.idleRpm);
      effRpm = targetRpm;
    } else if (Math.abs(st.gear) === 1) {
      const clutchRpm = p.idleRpm + (p.launchRpm - p.idleRpm) * throttleIn;
      targetRpm = Math.max(wheelRpm, clutchRpm);
      effRpm = targetRpm;
    } else {
      effRpm = wheelRpm;
      targetRpm = Math.max(wheelRpm, p.idleRpm * 0.8);
    }
    const rpmLag = env.frozen ? 6 : 25;
    st.rpm += (targetRpm - st.rpm) * Math.min(1, rpmLag * dt);
    if (st.rpm > p.maxRpm + 2500) st.rpm = p.maxRpm + 2500;
    st.overRev = Math.max(0, st.rpm - p.maxRpm);

    // Drehzahlbegrenzer
    let limiterCut = false;
    if (st.rpm >= p.maxRpm) {
      limiterCut = true;
      if (env.frozen) st.rpm = p.maxRpm - 200 - Math.random() * 300;
    }
    // Boxengassen-Begrenzer
    const pitL = track.pit;
    const inPitLane =
      track.inRange(st.s, pitL.sWallStart - 40, pitL.sWallEnd + 20) && Math.sign(st.d) === pitL.side && Math.abs(st.d) > pitL.wallD - 1.5;
    st.limiter = inPitLane;
    if (inPitLane && st.vx > pitL.speedLimit) throttleIn = 0;

    const rpmForPower = env.frozen ? st.rpm : Math.min(st.rpm, effRpm + 50);
    const engineW = (Math.max(rpmForPower, 400) * 2 * Math.PI) / 60;
    let power = p.icePower * powerFraction(rpmForPower) * throttleIn;
    // ERS (MGU-K, drehmomentbegrenzt)
    st.ersDeploying = false;
    if (throttleIn > 0.9 && st.gear >= 2 && st.ers > 0 && !inPitLane) {
      const dep = Math.min(p.ersPower, 190 * engineW, st.ers / dt);
      power += dep;
      st.ers -= dep * dt;
      st.ersDeploying = true;
    }
    if (env.fuelUse && st.fuel > 0) {
      st.fuel = Math.max(0, st.fuel - 0.032 * throttleIn * (st.rpm / p.maxRpm) * dt);
    }
    if (env.fuelUse && st.fuel <= 0) power = 0;
    let engineTorque = power / engineW;
    if (limiterCut && !env.frozen) engineTorque = 0;
    if (shifting) engineTorque *= 0.15;
    // Motorbremse (und Überdrehen nach zu frühem Runterschalten)
    let engineBrake = 0;
    if (st.gear !== 0 && !env.frozen) {
      const ebT = 95 * (st.rpm / p.maxRpm) * (1 - throttleIn) + st.overRev * 0.12;
      engineBrake = (ebT * ratio * p.drivetrainEff) / p.wheelRadius;
    }
    let driveForce = env.frozen || st.gear === 0 ? 0 : (engineTorque * ratio * p.drivetrainEff) / p.wheelRadius;
    if (st.gear < 0) driveForce = -Math.min(driveForce, 3500);

    // ------------------------------------------------ Aerodynamik
    const v2 = st.vx * st.vx;
    const slip = clamp(env.slipstream, 0, 1);
    const downforce = 0.5 * AIR_DENSITY * p.clA * v2 * (1 - 0.1 * slip);
    const drag = 0.5 * AIR_DENSITY * p.cdA * v2 * (1 - 0.32 * slip);

    // ------------------------------------------------ Radlasten
    const cosSlope = 1 / Math.sqrt(1 + gradF * gradF + gradL * gradL);
    const W = m * GRAVITY * cosSlope;
    const vComp = clamp(m * v2 * vcurv * alignT * alignT, -0.6 * m * GRAVITY, 0.8 * m * GRAVITY);
    const Wt = Math.max(0, W + vComp);
    const a = p.cgToFront;
    const b = p.cgToRear;
    const dLong = (m * st.ax * p.cgHeight) / L;
    const front = (Wt * b) / L - dLong + downforce * p.aeroFront;
    const rear = (Wt * a) / L + dLong + downforce * (1 - p.aeroFront);
    const dLatF = ((m * st.ay * p.cgHeight) / tw) * p.rollFront;
    const dLatR = ((m * st.ay * p.cgHeight) / tw) * (1 - p.rollFront);
    // ay > 0 (Beschleunigung nach links) -> Last wandert nach rechts (außen)
    const Fz = [
      Math.max(0, front / 2 - dLatF),
      Math.max(0, front / 2 + dLatF),
      Math.max(0, rear / 2 - dLatR),
      Math.max(0, rear / 2 + dLatR),
    ];

    // ------------------------------------------------ Reifenkräfte
    // Bremskraft je Rad
    let brakeTotal = brakeIn * p.brakeForceMax;
    if (env.frozen) brakeTotal = 0;
    const hb = clamp(inp.handbrake, 0, 1);
    const brakeReq = [
      brakeTotal * p.brakeBias * 0.5,
      brakeTotal * p.brakeBias * 0.5,
      brakeTotal * (1 - p.brakeBias) * 0.5 + hb * 9000,
      brakeTotal * (1 - p.brakeBias) * 0.5 + hb * 9000,
    ];
    const rearLoad = Fz[2] + Fz[3] || 1;
    const driveReq = [0, 0, (driveForce * Fz[2]) / rearLoad, (driveForce * Fz[3]) / rearLoad];
    const ebReq = [0, 0, (engineBrake * Fz[2]) / rearLoad, (engineBrake * Fz[3]) / rearLoad];

    let Fx = 0;
    let Fy = 0;
    let Mz = 0;
    const cosD = Math.cos(st.steer);
    const sinD = Math.sin(st.steer);
    let spinSum = 0;
    let lockSum = 0;
    let tcAct = 0;
    let absAct = 0;
    const vmin = 4;
    for (let i = 0; i < 4; i++) {
      const [px, py] = this.wheelPos[i];
      // Radgeschwindigkeit im Fahrzeugsystem
      const vwx0 = st.vx - st.yawRate * py;
      const vwy0 = st.vy + st.yawRate * px;
      const front = i < 2;
      const cd = front ? cosD : 1;
      const sd = front ? sinD : 0;
      const vwx = cd * vwx0 + sd * vwy0;
      const vwy = -sd * vwx0 + cd * vwy0;
      const alpha = Math.atan2(vwy, Math.max(Math.abs(vwx), vmin));
      st.slipAngle[i] = alpha;
      const fz = Fz[i];
      st.load[i] = fz;
      const mu = p.mu * this.loadSens(fz) * this.tyreGrip(i, env.weather) * gripSurf[i] * this.gripScale * (front ? 1 : REAR_GRIP);
      const cap = mu * fz;
      const fyPure = -sign(alpha) * cap * tyreCurve(Math.abs(alpha));
      // Längskraftwunsch (positiv = vorwärts)
      const dirV = Math.abs(vwx) > 0.05 ? sign(vwx) : 0;
      let fxReq = driveReq[i] - (brakeReq[i] + ebReq[i]) * dirV;
      // Stillstand: Bremse darf nicht umkehren
      if (dirV === 0) fxReq = driveReq[i];
      const fyRatio = cap > 1 ? Math.min(1, Math.abs(fyPure) / cap) : 1;
      const rAllowed = Math.pow(Math.max(0, 1 - Math.pow(fyRatio, 2.5)), 0.4);
      // Traktionskontrolle
      if (!front && driveReq[i] > 0 && this.assists.tc > 0) {
        const lim = this.assists.tc === 2 ? Math.max(0.22, rAllowed) * 0.97 : Math.max(0.42, rAllowed * 1.12);
        const maxF = lim * cap;
        if (fxReq > maxF) {
          fxReq = maxF;
          tcAct = 1;
        }
      }
      // ABS (nicht auf Handbremse)
      if (this.assists.abs && fxReq * dirV < 0 && hb < 0.05) {
        const lim = Math.max(0.3, rAllowed) * 0.97 * cap;
        if (Math.abs(fxReq) > lim) {
          fxReq = -lim * dirV;
          absAct = 1;
        }
      }
      const r = cap > 1 ? Math.abs(fxReq) / cap : 2;
      let fx: number;
      let fyMax: number;
      if (r <= 1) {
        fx = fxReq;
        fyMax = cap * Math.max(0.3, Math.pow(1 - Math.pow(r, 2.5), 0.4));
      } else {
        const excess = Math.min(1, (r - 1) * 1.5);
        fx = sign(fxReq) * cap * (1 - 0.12 * excess);
        fyMax = cap * 0.3 * (1 - 0.45 * excess);
        if (fxReq * dirV > 0 || (dirV === 0 && fxReq !== 0)) spinSum += excess;
        else lockSum += excess;
      }
      const fy = clamp(fyPure, -fyMax, fyMax);
      // Gleiten (für Audio/Partikel/Verschleiß)
      const slideLat = Math.abs(vwy) > 0.3 ? saturate((Math.abs(alpha) - ALPHA_PEAK * 0.9) / (ALPHA_PEAK * 2)) : 0;
      const slideLong = r > 1 ? saturate((r - 1) * 2 + 0.3) : 0;
      st.slide[i] = Math.max(slideLat, slideLong) * saturate(st.speed / 4);
      // Verschleiß ~ dissipierte Energie
      if (env.wearScale > 0) {
        const slipVel = Math.abs(vwy) + (r > 1 ? 4 : Math.abs(fx) / Math.max(cap, 1) * 0.6);
        const energy = (Math.abs(fy) * Math.abs(vwy) + Math.abs(fx) * slipVel * 0.25 + 30 * Math.abs(vwx)) * dt;
        st.tyreWear[i] = Math.min(1, st.tyreWear[i] + energy * 5.2e-8 * env.wearScale * p.tyreWear * COMPOUNDS[st.compound].wear[env.weather]);
      }
      // zurück ins Fahrzeugsystem
      const fxc = cd * fx - sd * fy;
      const fyc = sd * fx + cd * fy;
      Fx += fxc;
      Fy += fyc;
      Mz += px * fyc - py * fxc;
    }
    st.wheelspin = Math.min(1, spinSum / 2);
    st.lockup = Math.min(1, lockSum / 2);
    st.tcActive = tcAct;
    st.absActive = absAct;

    // ------------------------------------------------ Externe Kräfte
    Fx -= drag * sign(st.vx);
    Fx -= (0.012 + surfDrag) * m * GRAVITY * clamp(st.vx / 3, -1, 1);
    Fy -= surfDrag * m * GRAVITY * clamp(st.vy / 2, -1, 1);
    // Gravitation entlang der Oberfläche
    Fx -= m * GRAVITY * gradF * cosSlope;
    Fy -= m * GRAVITY * gradL * cosSlope;

    // ------------------------------------------------ Stabilitätsassistent
    if (this.assists.stability > 0 && st.vx > 5) {
      const aLat = this.lateralCapacity(st.vx, env.weather);
      const yawRef = clamp((st.vx * Math.tan(st.steer)) / L, -aLat / st.vx, aLat / st.vx);
      const err = st.yawRate - yawRef;
      const k = this.assists.stability;
      Mz -= err * p.izz * 9 * k;
      // seitliches Wegrutschen dämpfen
      Fy -= st.vy * m * 1.2 * k;
    }

    if (env.frozen) {
      st.vx = 0;
      st.vy = 0;
      st.yawRate = 0;
      st.ax = 0;
      st.ay = 0;
      this.postStep(dt, track);
      return;
    }

    // ------------------------------------------------ Integration
    const axBody = Fx / m;
    const ayBody = Fy / m;
    let dvx = (axBody + st.yawRate * st.vy) * dt;
    let dvy = (ayBody - st.yawRate * st.vx) * dt;
    const dr = (Mz / p.izz) * dt;

    // Kein Umkehren durch Bremsen/Widerstand
    if (driveForce === 0 && Math.abs(st.vx) < 1.0 && Math.sign(st.vx + dvx) !== Math.sign(st.vx) && st.vx !== 0) {
      dvx = -st.vx;
    }
    st.vx += dvx;
    st.vy += dvy;
    st.yawRate += dr;

    // Niedriggeschwindigkeits-Stabilisierung (kinematisches Modell)
    const spd = Math.abs(st.vx);
    if (spd < 4) {
      const f = 1 - spd / 4;
      const rKin = (st.vx * Math.tan(st.steer)) / L;
      st.yawRate += (rKin - st.yawRate) * Math.min(1, 12 * f * dt);
      st.vy *= Math.exp(-8 * f * dt);
      dvy = 0;
    }
    if (Math.abs(st.vx) < 0.05 && driveForce === 0 && brakeIn > 0.05) {
      st.vx = 0;
      st.vy *= 0.5;
      st.yawRate *= 0.5;
    }

    st.heading += st.yawRate * dt;
    const vxW = st.vx * fwdX + st.vy * leftX;
    const vzW = st.vx * fwdZ + st.vy * leftZ;
    st.x += vxW * dt;
    st.z += vzW * dt;
    st.odometer += Math.hypot(vxW, vzW) * dt;

    // gefilterte Beschleunigungen für die Lastverlagerung
    const fa = Math.min(1, 20 * dt);
    st.ax += (axBody - st.ax) * fa;
    st.ay += (ayBody - st.ay) * fa;
    // ERS-Rückgewinnung beim Bremsen / Lupfen
    if (brakeIn > 0.1 && st.vx > 10) st.ers = Math.min(p.ersCapacity, st.ers + Math.min(p.ersPower, brakeTotal * st.vx * 0.15) * dt);
    else if (throttleIn < 0.3 && st.vx > 25) st.ers = Math.min(p.ersCapacity, st.ers + 40000 * dt);

    this.postStep(dt, track);
    st.bump = bumpAmt;
    this.guardFinite();
  }

  /** Schutz gegen numerische Ausreißer (NaN/Inf): Zustand auf letzten gültigen Wert zurücksetzen. */
  private lastGood = { x: 0, z: 0, heading: 0 };
  private guardFinite(): void {
    const st = this.st;
    if (Number.isFinite(st.x) && Number.isFinite(st.z) && Number.isFinite(st.vx) && Number.isFinite(st.vy) && Number.isFinite(st.yawRate) && Number.isFinite(st.heading)) {
      this.lastGood.x = st.x;
      this.lastGood.z = st.z;
      this.lastGood.heading = st.heading;
      return;
    }
    st.x = this.lastGood.x;
    st.z = this.lastGood.z;
    st.heading = this.lastGood.heading;
    st.vx = 0;
    st.vy = 0;
    st.yawRate = 0;
    st.ax = 0;
    st.ay = 0;
    st.steer = 0;
  }

  private postStep(dt: number, _track: Track): void {
    const st = this.st;
    const p = this.p;
    // Visuelle Karosseriebewegung (Nicken/Wanken aus Beschleunigung)
    st.bodyPitch += (clamp(-st.ax * 0.0022, -0.03, 0.03) - st.bodyPitch) * Math.min(1, 10 * dt);
    st.bodyRoll += (clamp(st.ay * 0.0016, -0.03, 0.03) - st.bodyRoll) * Math.min(1, 10 * dt);
    // Raddrehung
    const spinBoost = st.wheelspin * 25;
    for (let i = 0; i < 4; i++) {
      const locked = i < 2 ? st.lockup > 0.5 : st.lockup > 0.7;
      let w = st.vx / p.wheelRadius;
      if (i >= 2) w += spinBoost * Math.sign(st.vx || 1);
      if (locked) w = 0;
      st.wheelRot[i] += w * dt;
    }
  }

  private updateGearbox(inp: CarInput, dt: number, throttle: number, brake: number): void {
    const st = this.st;
    const p = this.p;
    if (st.shiftTimer > 0) {
      st.shiftTimer -= dt;
      if (st.shiftTimer <= 0) {
        st.gear = st.pendingGear;
        st.shiftTimer = 0;
      }
      return;
    }
    const nGears = p.gearRatios.length;
    if (this.assists.autoGear) {
      if (st.gear < 1) return;
      const rpm = this.rpmForGear(st.gear, st.vx);
      if (rpm > p.maxRpm - 450 && st.gear < nGears && throttle > 0.05) this.requestShift(st.gear + 1);
      else if (st.gear > 1) {
        const lowerRpm = this.rpmForGear(st.gear - 1, st.vx);
        const downThreshold = brake > 0.2 ? p.maxRpm - 1400 : p.maxRpm - 2600;
        if (lowerRpm < downThreshold && rpm < 9500) this.requestShift(st.gear - 1);
      }
    } else {
      if (inp.shiftUp) {
        if (st.gear < 0) this.requestShift(1);
        else if (st.gear < nGears) this.requestShift(st.gear + 1);
      }
      if (inp.shiftDown) {
        if (st.gear === 1) {
          if (Math.abs(st.vx) < 2) this.requestShift(-1);
        } else if (st.gear > 1) {
          const newRpm = this.rpmForGear(st.gear - 1, st.vx);
          if (newRpm > p.maxRpm + 1800) this.overRevDenied = true;
          else this.requestShift(st.gear - 1);
        }
      }
    }
  }

  private requestShift(g: number): void {
    const st = this.st;
    st.pendingGear = g;
    st.shiftTimer = this.p.shiftTime;
    this.shiftedThisStep = g > st.gear ? 1 : -1;
  }
}
