// Kollisionserkennung und -antwort: Fahrzeug gegen Streckenbegrenzung/Boxenmauer und Fahrzeug gegen Fahrzeug.
import type { Car } from './carPhysics';
import { clamp } from './math';
import type { Track } from './track';

const FRONT = 2.95;
const REAR = -2.55;
const HALF_W = 0.97;
const CORNERS: [number, number][] = [
  [FRONT, HALF_W],
  [FRONT, -HALF_W],
  [REAR, HALF_W],
  [REAR, -HALF_W],
  [0.4, HALF_W],
  [0.4, -HALF_W],
];

export interface WallHit {
  impact: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Hält das Fahrzeug innerhalb der Barrieren und der Boxenmauer.
 * Gibt die Aufprallgeschwindigkeit (m/s, Normalkomponente) zurück, 0 wenn kein Kontakt.
 */
export function collideWalls(car: Car, track: Track, hit?: WallHit): number {
  const st = car.st;
  const fwdX = Math.sin(st.heading);
  const fwdZ = Math.cos(st.heading);
  const leftX = Math.cos(st.heading);
  const leftZ = -Math.sin(st.heading);
  // Streckentangente am Fahrzeug
  const i = track.indexAt(st.s);
  const tx = track.tx[i];
  const tz = track.tz[i];
  const nx = tz;
  const nz = -tx;
  const pit = track.pit;
  const inWall = track.inRange(st.s, pit.sWallStart, pit.sWallEnd);
  const centerPitSide = pit.side * st.d - pit.wallD;

  let bestPen = 0;
  let bestNx = 0;
  let bestNz = 0;
  let bestOx = 0;
  let bestOz = 0;
  for (const [px, py] of CORNERS) {
    const ox = fwdX * px + leftX * py;
    const oz = fwdZ * px + leftZ * py;
    const sc = st.s + ox * tx + oz * tz;
    const dc = st.d + ox * nx + oz * nz;
    const left = dc > 0;
    const bar = track.barrierAt(sc, left);
    let pen = Math.abs(dc) - bar;
    let wnx = left ? nx : -nx;
    let wnz = left ? nz : -nz;
    // Boxenmauer (zweiseitig)
    if (inWall && track.inRange(sc, pit.sWallStart, pit.sWallEnd)) {
      const cs = pit.side * dc - pit.wallD;
      if (centerPitSide < 0 && cs > -0.2) {
        const pw = cs + 0.2;
        if (pw > pen) {
          pen = pw;
          wnx = pit.side * nx;
          wnz = pit.side * nz;
        }
      } else if (centerPitSide >= 0 && cs < 0.2) {
        const pw = 0.2 - cs;
        if (pw > pen) {
          pen = pw;
          wnx = -pit.side * nx;
          wnz = -pit.side * nz;
        }
      }
    }
    if (pen > bestPen) {
      bestPen = pen;
      bestNx = wnx;
      bestNz = wnz;
      bestOx = ox;
      bestOz = oz;
    }
  }
  if (bestPen <= 0) {
    st.scrape *= 0.9;
    return 0;
  }
  // Position korrigieren
  st.x -= bestNx * bestPen;
  st.z -= bestNz * bestPen;
  // Geschwindigkeit in Welt
  let vX = st.vx * fwdX + st.vy * leftX;
  let vZ = st.vx * fwdZ + st.vy * leftZ;
  // Geschwindigkeit des Kontaktpunkts inkl. Drehung: v + ω × r  (ω um +Y)
  const cvX = vX + st.yawRate * bestOz;
  const cvZ = vZ - st.yawRate * bestOx;
  const vn = cvX * bestNx + cvZ * bestNz;
  let impact = 0;
  if (vn > 0) {
    const e = 0.22;
    const m = car.mass;
    const I = car.p.izz;
    const rCrossN = bestOz * bestNx - bestOx * bestNz;
    const jn = ((1 + e) * vn) / (1 / m + (rCrossN * rCrossN) / I);
    let Jx = -jn * bestNx;
    let Jz = -jn * bestNz;
    // Reibung entlang der Wand
    const tX = -bestNz;
    const tZ = bestNx;
    const vt = cvX * tX + cvZ * tZ;
    const jtMax = 0.45 * jn;
    const jt = clamp(-vt * m * 0.6, -jtMax, jtMax);
    Jx += jt * tX;
    Jz += jt * tZ;
    vX += Jx / m;
    vZ += Jz / m;
    st.yawRate += (bestOz * Jx - bestOx * Jz) / I;
    st.yawRate *= 0.92;
    impact = vn;
    st.impact = Math.max(st.impact, vn);
  }
  // Schleifen an der Wand
  const speed = Math.hypot(vX, vZ);
  st.scrape = Math.max(st.scrape * 0.9, speed > 3 ? 1 : 0);
  // zurück ins Fahrzeugsystem
  st.vx = vX * fwdX + vZ * fwdZ;
  st.vy = vX * leftX + vZ * leftZ;
  if (hit) {
    hit.impact = impact;
    hit.x = st.x + bestOx;
    hit.z = st.z + bestOz;
    hit.y = st.y + 0.4;
  }
  return impact;
}

const CIRCLES = [2.05, 0.0, -1.85];
const RADIUS = 1.02;

/**
 * Kollision zweier Fahrzeuge (Kreis-Approximation). Ist bKinematic gesetzt, wird nur a bewegt
 * (z. B. Mitspieler im Netzwerk, deren Position ein anderer Client simuliert).
 * Gibt die Aufprallgeschwindigkeit zurück.
 */
export function collideCars(a: Car, b: Car, bKinematic = false): number {
  const A = a.st;
  const B = b.st;
  const dx0 = A.x - B.x;
  const dz0 = A.z - B.z;
  if (dx0 * dx0 + dz0 * dz0 > 49) return 0;
  if (Math.abs(A.y - B.y) > 3) return 0;
  const afx = Math.sin(A.heading);
  const afz = Math.cos(A.heading);
  const bfx = Math.sin(B.heading);
  const bfz = Math.cos(B.heading);
  let best = 0;
  let nX = 0;
  let nZ = 0;
  let cAx = 0;
  let cAz = 0;
  let cBx = 0;
  let cBz = 0;
  for (const oa of CIRCLES) {
    const ax = A.x + afx * oa;
    const az = A.z + afz * oa;
    for (const ob of CIRCLES) {
      const bx = B.x + bfx * ob;
      const bz = B.z + bfz * ob;
      const dx = ax - bx;
      const dz = az - bz;
      const d2 = dx * dx + dz * dz;
      const minD = RADIUS * 2;
      if (d2 < minD * minD) {
        const d = Math.sqrt(d2) || 0.001;
        const pen = minD - d;
        if (pen > best) {
          best = pen;
          nX = dx / d;
          nZ = dz / d;
          cAx = afx * oa - nX * RADIUS;
          cAz = afz * oa - nZ * RADIUS;
          cBx = bfx * ob + nX * RADIUS;
          cBz = bfz * ob + nZ * RADIUS;
        }
      }
    }
  }
  if (best <= 0) return 0;
  const ma = a.mass;
  const mb = bKinematic ? Infinity : b.mass;
  const ia = a.p.izz;
  const ib = bKinematic ? Infinity : b.p.izz;
  const wa = 1 / ma;
  const wb = bKinematic ? 0 : 1 / mb;
  // Positionskorrektur
  const tot = wa + wb;
  A.x += nX * best * (wa / tot);
  A.z += nZ * best * (wa / tot);
  if (!bKinematic) {
    B.x -= nX * best * (wb / tot);
    B.z -= nZ * best * (wb / tot);
  }
  // Geschwindigkeiten in Welt
  const alx = Math.cos(A.heading);
  const alz = -Math.sin(A.heading);
  const blx = Math.cos(B.heading);
  const blz = -Math.sin(B.heading);
  let avX = A.vx * afx + A.vy * alx;
  let avZ = A.vx * afz + A.vy * alz;
  let bvX = B.vx * bfx + B.vy * blx;
  let bvZ = B.vx * bfz + B.vy * blz;
  const pAx = avX + A.yawRate * cAz;
  const pAz = avZ - A.yawRate * cAx;
  const pBx = bvX + B.yawRate * cBz;
  const pBz = bvZ - B.yawRate * cBx;
  const rvX = pAx - pBx;
  const rvZ = pAz - pBz;
  const vn = rvX * nX + rvZ * nZ;
  if (vn >= 0) return 0;
  const e = 0.18;
  const rA = cAz * nX - cAx * nZ;
  const rB = cBz * nX - cBx * nZ;
  const denom = wa + wb + (rA * rA) / ia + (bKinematic ? 0 : (rB * rB) / ib);
  const j = (-(1 + e) * vn) / denom;
  // Reibung
  const tX = -nZ;
  const tZ = nX;
  const vt = rvX * tX + rvZ * tZ;
  const jt = clamp(-vt / denom, -0.35 * j, 0.35 * j);
  const Jx = j * nX + jt * tX;
  const Jz = j * nZ + jt * tZ;
  avX += Jx * wa;
  avZ += Jz * wa;
  A.yawRate += (cAz * Jx - cAx * Jz) / ia;
  A.vx = avX * afx + avZ * afz;
  A.vy = avX * alx + avZ * alz;
  A.impact = Math.max(A.impact, -vn);
  if (!bKinematic) {
    bvX -= Jx * wb;
    bvZ -= Jz * wb;
    B.yawRate -= (cBz * Jx - cBx * Jz) / ib;
    B.vx = bvX * bfx + bvZ * bfz;
    B.vy = bvX * blx + bvZ * blz;
    B.impact = Math.max(B.impact, -vn);
  }
  return -vn;
}
