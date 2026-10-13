// Ideallinie (Minimal-Krümmungs-Näherung) und Geschwindigkeitsprofil.
import { AIR_DENSITY, GRAVITY, type Car, type Weather } from './carPhysics';
import { clamp, mod } from './math';
import type { Track } from './track';

export interface RaceLineData {
  /** Weltpositionen der Ideallinie */
  x: Float32Array;
  z: Float32Array;
  /** vorzeichenbehaftete Krümmung der Ideallinie */
  k: Float32Array;
  /** Segmentlänge der Ideallinie ab Sample i */
  ds: Float32Array;
}

/** Berechnet die Ideallinie als seitlichen Versatz je Sample (track.raceLine). */
export function computeRacingLine(track: Track): RaceLineData {
  const n = track.n;
  const off = new Float64Array(n);
  const lim = new Float64Array(n);
  for (let i = 0; i < n; i++) lim[i] = Math.max(0.5, track.halfW[i] - 1.45);
  const px = track.px;
  const pz = track.pz;
  const nx = track.nx;
  const nz = track.nz;
  // Mehrstufige biharmonische Relaxation: minimiert die Summe der quadrierten zweiten Differenzen
  // (≈ Krümmung²) – ergibt die klassische Außen-Innen-Außen-Linie.
  const stages: [number, number][] = [
    [40, 80],
    [20, 120],
    [10, 160],
    [5, 220],
    [3, 260],
    [2, 260],
  ];
  for (const [k, iters] of stages) {
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < n; i++) {
        const a2 = mod(i - 2 * k, n);
        const a1 = mod(i - k, n);
        const b1 = (i + k) % n;
        const b2 = (i + 2 * k) % n;
        const tx = (-(px[a2] + nx[a2] * off[a2]) + 4 * (px[a1] + nx[a1] * off[a1]) + 4 * (px[b1] + nx[b1] * off[b1]) - (px[b2] + nx[b2] * off[b2])) / 6;
        const tz = (-(pz[a2] + nz[a2] * off[a2]) + 4 * (pz[a1] + nz[a1] * off[a1]) + 4 * (pz[b1] + nz[b1] * off[b1]) - (pz[b2] + nz[b2] * off[b2])) / 6;
        const target = (tx - px[i]) * nx[i] + (tz - pz[i]) * nz[i];
        off[i] = clamp(off[i] + (target - off[i]) * 0.5, -lim[i], lim[i]);
      }
    }
  }
  for (let i = 0; i < n; i++) track.raceLine[i] = off[i];
  return buildLineData(track);
}

export function buildLineData(track: Track): RaceLineData {
  const n = track.n;
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const k = new Float32Array(n);
  const ds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = track.px[i] + track.nx[i] * track.raceLine[i];
    z[i] = track.pz[i] + track.nz[i] * track.raceLine[i];
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ds[i] = Math.hypot(x[j] - x[i], z[j] - z[i]);
  }
  // Krümmung über Umkreis aus Punkten im Abstand ±3
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = mod(i - 3, n);
    const b = (i + 3) % n;
    const ax = x[i] - x[a];
    const az = z[i] - z[a];
    const bx = x[b] - x[i];
    const bz = z[b] - z[i];
    const cross = ax * bz - az * bx;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    const lc = Math.hypot(x[b] - x[a], z[b] - z[a]);
    // Vorzeichen: links = positiv (Kreuzprodukt in x/z-Ebene ist bei Linkskurve negativ)
    raw[i] = (-2 * cross) / Math.max(1e-6, la * lb * lc);
  }
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let q = -2; q <= 2; q++) s += raw[mod(i + q, n)];
    k[i] = s / 5;
  }
  return { x, z, k, ds };
}

export interface SpeedProfile {
  v: Float32Array;
  lapTime: number;
}

/**
 * Geschwindigkeitsprofil entlang der Ideallinie für ein Fahrzeug.
 * gripFactor < 1 lässt Reserve (KI-Können / Sicherheit).
 */
export function computeSpeedProfile(track: Track, line: RaceLineData, car: Car, weather: Weather, gripFactor: number, brakeFactor = gripFactor): SpeedProfile {
  const n = track.n;
  const p = car.p;
  const m = car.mass;
  const vTop = 102;
  const v = new Float32Array(n);
  const aLat = (spd: number) => car.lateralCapacity(spd, weather) * gripFactor;
  for (let i = 0; i < n; i++) {
    const kk = Math.abs(line.k[i]);
    // Querneigung hilft in passender Richtung
    const bank = track.bank[i];
    const bankHelp = GRAVITY * Math.sin(bank) * Math.sign(-line.k[i] || 1) * 0.9;
    let spd = vTop;
    if (kk > 1e-5) {
      for (let it = 0; it < 8; it++) spd = Math.min(vTop, Math.sqrt(Math.max(1, aLat(spd) + Math.max(0, bankHelp)) / kk));
    }
    v[i] = spd;
  }
  const dragAcc = (spd: number) => (0.5 * AIR_DENSITY * p.cdA * spd * spd) / m;
  // Rückwärts (Bremsen), zweimal um die Schleife
  for (let pass = 0; pass < 2; pass++) {
    for (let c = n - 1; c >= 0; c--) {
      const i = c;
      const j = (i + 1) % n;
      const vj = v[j];
      const total = aLat(vj) * 0.97 * (brakeFactor / gripFactor);
      const lat = vj * vj * Math.abs(line.k[j]);
      const avail = Math.sqrt(Math.max(0, total * total - lat * lat)) + dragAcc(vj) + GRAVITY * track.slope[i];
      const vmax = Math.sqrt(vj * vj + 2 * Math.max(2, avail) * line.ds[i]);
      if (vmax < v[i]) v[i] = vmax;
    }
  }
  // Vorwärts (Beschleunigen)
  const power = p.icePower + p.ersPower * 0.5;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const vi = Math.max(1, v[i]);
      const total = aLat(vi);
      const lat = vi * vi * Math.abs(line.k[i]);
      const tract = Math.sqrt(Math.max(0, total * total - lat * lat)) * 0.55;
      const pw = (power * p.drivetrainEff) / (m * vi);
      const acc = Math.min(tract, pw) - dragAcc(vi) - GRAVITY * track.slope[i];
      const vmax = Math.sqrt(Math.max(0, vi * vi + 2 * Math.max(0.3, acc) * line.ds[i]));
      if (vmax < v[j]) v[j] = vmax;
    }
  }
  let t = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    t += line.ds[i] / Math.max(1, (v[i] + v[j]) * 0.5);
  }
  return { v, lapTime: t };
}
