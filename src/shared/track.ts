// Streckenmodell: baut aus einer Turtle-Definition (Geraden/Kurven) eine abgetastete Mittellinie
// mit Breite, Höhenprofil, Banking, Curbs, Auslaufzonen, Barrieren und Boxengasse.
// Rein numerisch (keine DOM-/Three.js-Abhängigkeit), damit Client, Server und Tests es teilen.

import { clamp, mod, smoothstep } from './math';

export type RunoffType = 'grass' | 'gravel' | 'asphalt';
export type SegFlag = 'tunnel' | 'hotel';

export interface SegOpts {
  /** Höhe (m) am Segmentende */
  y?: number;
  /** Streckenbreite (m) */
  w?: number;
  /** Querneigung in Grad (positiv = linke Seite höher) */
  bank?: number;
  /** Kurven-/Abschnittsname */
  name?: string;
  /** Länge wird automatisch zum Schließen der Strecke berechnet (genau zwei Geraden) */
  auto?: boolean;
  /** Winkel wird automatisch zum Schließen berechnet (genau eine Kurve) */
  autoAng?: boolean;
  /** Auslaufzone (m) für beide Seiten */
  ro?: number;
  roT?: RunoffType;
  flag?: SegFlag;
}

export type Seg = { k: 'S'; len: number; o: SegOpts } | { k: 'C'; ang: number; r: number; o: SegOpts };

export const S = (len: number, o: SegOpts = {}): Seg => ({ k: 'S', len, o });
/** Linkskurve (Winkel in Grad, Radius in m) */
export const L = (ang: number, r: number, o: SegOpts = {}): Seg => ({ k: 'C', ang, r, o });
/** Rechtskurve */
export const R = (ang: number, r: number, o: SegOpts = {}): Seg => ({ k: 'C', ang: -ang, r, o });

export type TimeOfDay = 'day' | 'overcast' | 'afternoon' | 'dusk';
export type SceneryTheme = 'parkland' | 'city' | 'forest' | 'desert' | 'dunes' | 'hills';

export interface EnvDef {
  theme: SceneryTheme;
  time: TimeOfDay;
  skyTop: string;
  skyHorizon: string;
  fog: string;
  fogDensity: number;
  sunElevation: number;
  sunAzimuth: number;
  sunColor: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  grass: string;
  ground: string;
  trees: number;
  treeType: 'broadleaf' | 'pine' | 'palm' | 'mixed';
  buildings: number;
  /** Wasser jenseits einer Linie: Richtung (Grad, 0 = +Z) und Abstand vom Streckenmittelpunkt */
  water?: { dir: number; dist: number };
  mountains: boolean;
  floodlights: boolean;
}

export interface TrackDef {
  id: string;
  name: string;
  location: string;
  country: string;
  flag: string;
  /** Reale Streckenlänge in km – die Strecke wird exakt auf diesen Wert skaliert */
  lengthKm: number;
  realLaps: number;
  defaultLaps: number;
  dir: 'cw' | 'ccw' | 'fig8';
  width: number;
  runoff: number;
  runoffType: RunoffType;
  cornerRunoff: number;
  cornerRunoffType: RunoffType;
  barrier: 'armco' | 'concrete' | 'tecpro';
  startHeading: number;
  y0?: number;
  segs: Seg[];
  pit: { side: 'L' | 'R'; entry: number; exit: number };
  sectors: [number, number];
  description: string;
  character: string;
  env: EnvDef;
}

export interface Corner {
  start: number;
  end: number;
  apex: number;
  dir: 1 | -1;
  minRadius: number;
  name?: string;
}

export interface Projection {
  i: number;
  s: number;
  d: number;
  y: number;
  /** Tangente (x,z) */
  tx: number;
  tz: number;
  dist2: number;
}

export interface PitLane {
  side: 1 | -1;
  sEntry: number;
  sWallStart: number;
  sWallEnd: number;
  sExit: number;
  wallD: number;
  laneCenter: number;
  boxLane: number;
  outerD: number;
  speedLimit: number;
  boxes: number[];
}

export const SURF_ASPHALT = 0;
export const SURF_CURB = 1;
export const SURF_RUNOFF_ASPHALT = 2;
export const SURF_GRASS = 3;
export const SURF_GRAVEL = 4;
export const SURF_PIT = 5;

const RUNOFF_CODE: Record<RunoffType, number> = { asphalt: SURF_RUNOFF_ASPHALT, grass: SURF_GRASS, gravel: SURF_GRAVEL };

export const SAMPLE_SPACING = 2;
export const CURB_WIDTH = 1.3;

interface RawPoint {
  s: number;
  /** kumulative Richtungsänderung am Punkt (rad) */
  th: number;
  k: number;
  w: number;
  bank: number;
  seg: number;
}

export class Track {
  readonly def: TrackDef;
  readonly n: number;
  readonly length: number;
  readonly spacing: number;
  readonly scale: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  readonly nx: Float32Array;
  readonly nz: Float32Array;
  readonly curv: Float32Array;
  readonly halfW: Float32Array;
  readonly bank: Float32Array;
  readonly slope: Float32Array;
  readonly vcurv: Float32Array;
  readonly curbL: Uint8Array;
  readonly curbR: Uint8Array;
  readonly runL: Float32Array;
  readonly runR: Float32Array;
  readonly runTypeL: Uint8Array;
  readonly runTypeR: Uint8Array;
  readonly barL: Float32Array;
  readonly barR: Float32Array;
  readonly flags: Uint8Array;
  readonly segOf: Uint16Array;
  readonly corners: Corner[] = [];
  readonly sectors: [number, number];
  readonly pit: PitLane;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly minY: number;
  readonly maxY: number;
  /** Racing line (seitlicher Versatz pro Sample) – wird von racingLine.ts gefüllt */
  raceLine: Float32Array;
  private grid = new Map<number, number[]>();
  private readonly cell = 24;
  readonly warnings: string[] = [];
  /** Bei Achterschleifen: Index des unteren und oberen Durchgangs an der Kreuzung */
  crossing: { under: number; over: number } | null = null;

  constructor(def: TrackDef) {
    this.def = def;
    const raw = buildRaw(def);
    const targetLen = def.lengthKm * 1000;
    this.scale = targetLen / raw.length;
    this.length = targetLen;
    const n = Math.round(targetLen / SAMPLE_SPACING);
    this.n = n;
    this.spacing = targetLen / n;
    const sp = this.spacing;

    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.nx = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.curv = new Float32Array(n);
    this.halfW = new Float32Array(n);
    this.bank = new Float32Array(n);
    this.slope = new Float32Array(n);
    this.vcurv = new Float32Array(n);
    this.curbL = new Uint8Array(n);
    this.curbR = new Uint8Array(n);
    this.runL = new Float32Array(n);
    this.runR = new Float32Array(n);
    this.runTypeL = new Uint8Array(n);
    this.runTypeR = new Uint8Array(n);
    this.barL = new Float32Array(n);
    this.barR = new Float32Array(n);
    this.flags = new Uint8Array(n);
    this.segOf = new Uint16Array(n);
    this.raceLine = new Float32Array(n);

    // --- Krümmung, Breite, Banking aus den Rohdaten interpolieren (skaliert) ---
    const k = new Float64Array(n);
    const w = new Float64Array(n);
    const bk = new Float64Array(n);
    // Exakte mittlere Krümmung je Intervall über die kumulative Richtungsfunktion
    const pts = raw.points;
    const thetaAt = (sRaw: number, hint: { j: number }): number => {
      while (hint.j < pts.length - 2 && pts[hint.j + 1].s <= sRaw) hint.j++;
      const a = pts[hint.j];
      return a.th + a.k * (sRaw - a.s);
    };
    const hA = { j: 0 };
    const hB = { j: 0 };
    let rj = 0;
    for (let i = 0; i < n; i++) {
      const s0 = (i * sp) / this.scale;
      const s1 = ((i + 1) * sp) / this.scale;
      k[i] = (thetaAt(s1, hB) - thetaAt(s0, hA)) / sp;
      const sMid = (s0 + s1) * 0.5;
      while (rj < pts.length - 2 && pts[rj + 1].s < sMid) rj++;
      const p = pts[rj];
      w[i] = p.w;
      bk[i] = p.bank;
      this.segOf[i] = p.seg;
      const f = def.segs[p.seg].o.flag;
      this.flags[i] = f === 'tunnel' ? 1 : f === 'hotel' ? 2 : 0;
    }
    // Krümmung glätten (Klothoiden-ähnliche Übergänge), Integral bleibt erhalten
    const kS = boxSmooth(boxSmooth(k, Math.max(1, Math.round(7 / sp))), Math.max(1, Math.round(7 / sp)));
    const wS = boxSmooth(boxSmooth(w, Math.round(20 / sp)), Math.round(20 / sp));
    const bS = boxSmooth(boxSmooth(bk, Math.round(25 / sp)), Math.round(25 / sp));

    // --- Integration von Richtung und Position ---
    let th = (def.startHeading * Math.PI) / 180;
    let x = 0;
    let z = 0;
    const xs = new Float64Array(n + 1);
    const zs = new Float64Array(n + 1);
    const ths = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      xs[i] = x;
      zs[i] = z;
      ths[i] = th;
      const thMid = th + kS[i] * sp * 0.5;
      x += Math.sin(thMid) * sp;
      z += Math.cos(thMid) * sp;
      th += kS[i] * sp;
    }
    xs[n] = x;
    zs[n] = z;
    ths[n] = th;
    // Schließfehler linear verteilen
    const ex = xs[n] - xs[0];
    const ez = zs[n] - zs[0];
    if (Math.hypot(ex, ez) > 25) this.warnings.push(`Schließfehler ${Math.hypot(ex, ez).toFixed(1)} m`);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      this.px[i] = xs[i] - ex * f;
      this.pz[i] = zs[i] - ez * f;
    }
    // Tangenten aus den korrigierten Positionen (zentrale Differenzen)
    for (let i = 0; i < n; i++) {
      const a = mod(i - 1, n);
      const b = (i + 1) % n;
      let dx = this.px[b] - this.px[a];
      let dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      this.tx[i] = dx;
      this.tz[i] = dz;
      // linke Normale: (cos th, -sin th) bei Vorwärts (sin th, cos th)
      this.nx[i] = dz;
      this.nz[i] = -dx;
      this.curv[i] = kS[i];
      this.halfW[i] = wS[i] * 0.5;
      this.bank[i] = (bS[i] * Math.PI) / 180;
    }

    // --- Höhenprofil ---
    const yKeys: { s: number; y: number }[] = [];
    let acc = 0;
    yKeys.push({ s: 0, y: def.y0 ?? 0 });
    def.segs.forEach((seg, si) => {
      acc += raw.segLen[si];
      if (seg.o.y !== undefined) yKeys.push({ s: acc * this.scale, y: seg.o.y });
    });
    const yRaw = new Float64Array(n);
    if (yKeys.length > 1) {
      // Zyklisch linear interpolieren
      const keys = yKeys.slice();
      keys.push({ s: targetLen, y: keys[0].y });
      let kj = 0;
      for (let i = 0; i < n; i++) {
        const s = i * sp;
        while (kj < keys.length - 2 && keys[kj + 1].s < s) kj++;
        const a = keys[kj];
        const b = keys[kj + 1];
        const t = b.s > a.s ? clamp((s - a.s) / (b.s - a.s), 0, 1) : 0;
        yRaw[i] = a.y + (b.y - a.y) * t;
      }
    } else {
      yRaw.fill(def.y0 ?? 0);
    }
    const yS = boxSmooth(boxSmooth(boxSmooth(yRaw, Math.round(30 / sp)), Math.round(30 / sp)), Math.round(20 / sp));
    for (let i = 0; i < n; i++) this.py[i] = yS[i];
    if (def.dir === 'fig8') this.raiseOverpass();
    for (let i = 0; i < n; i++) {
      const a = mod(i - 1, n);
      const b = (i + 1) % n;
      this.slope[i] = (this.py[b] - this.py[a]) / (2 * sp);
      this.vcurv[i] = (this.py[b] - 2 * this.py[i] + this.py[a]) / (sp * sp);
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]);
      maxZ = Math.max(maxZ, this.pz[i]);
      minY = Math.min(minY, this.py[i]);
      maxY = Math.max(maxY, this.py[i]);
    }
    this.minX = minX;
    this.maxX = maxX;
    this.minZ = minZ;
    this.maxZ = maxZ;
    this.minY = minY;
    this.maxY = maxY;

    for (let i = 0; i < n; i++) {
      const cx = Math.floor(this.px[i] / this.cell);
      const cz = Math.floor(this.pz[i] / this.cell);
      const key = cellKey(cx, cz);
      let arr = this.grid.get(key);
      if (!arr) this.grid.set(key, (arr = []));
      arr.push(i);
    }

    this.sectors = [def.sectors[0] * targetLen, def.sectors[1] * targetLen];
    this.detectCorners();
    this.buildRunoffAndCurbs();
    this.pit = this.buildPit();
    this.clampBarriers();
    // Racing line initial: Mittellinie
    this.raceLine.fill(0);
  }

  // ------------------------------------------------------------------ Aufbau

  /** Findet bei Achterschleifen die Kreuzung und hebt den zweiten Durchgang als Brücke an. */
  private raiseOverpass(): void {
    const n = this.n;
    const px = this.px;
    const pz = this.pz;
    let cross: [number, number] | null = null;
    for (let i = 0; i < n && !cross; i++) {
      const i2 = (i + 1) % n;
      const ax = px[i], az = pz[i], bx = px[i2], bz = pz[i2];
      for (let j = i + 60; j < n - 1; j++) {
        if (n - j + i < 60) break;
        const cx = px[j], cz = pz[j];
        if (Math.abs(cx - ax) > 30 || Math.abs(cz - az) > 30) continue;
        const dx = px[j + 1], dz = pz[j + 1];
        const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
        const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
        const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
        if (d1 * d2 < 0 && d3 * d4 < 0) {
          cross = [i, j];
          break;
        }
      }
    }
    if (!cross) {
      this.warnings.push('Achterschleife ohne Kreuzung');
      return;
    }
    const [lo, hi] = cross;
    this.crossing = { under: lo, over: hi };
    const H = 9.5 + Math.max(0, this.py[lo] - this.py[hi]);
    const half = 230 / this.spacing;
    for (let k = -Math.ceil(half); k <= Math.ceil(half); k++) {
      const idx = mod(hi + k, n);
      const t = Math.abs(k) / half;
      const w = t >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * t));
      this.py[idx] += H * w;
    }
  }

  private detectCorners(): void {
    const n = this.n;
    const thr = 1 / 320;
    // Startpunkt in einer Geraden suchen, damit Kurven nicht über s=0 zerschnitten werden
    let start = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(this.curv[i]) < thr * 0.5) {
        start = i;
        break;
      }
    }
    let inCorner = false;
    let cs = 0;
    let dir: 1 | -1 = 1;
    let minR = Infinity;
    let apex = 0;
    const flush = (end: number) => {
      const len = mod(end - cs, n) * this.spacing;
      if (len > 8) {
        const segIdx = this.segOf[mod(apex, n)];
        this.corners.push({
          start: cs,
          end,
          apex,
          dir,
          minRadius: minR,
          name: this.def.segs[segIdx]?.o.name,
        });
      }
    };
    for (let c = 0; c <= n; c++) {
      const i = (start + c) % n;
      const kk = this.curv[i];
      const isC = Math.abs(kk) > thr;
      const d: 1 | -1 = kk > 0 ? 1 : -1;
      if (isC && (!inCorner || d !== dir)) {
        if (inCorner) flush(i);
        inCorner = true;
        cs = i;
        dir = d;
        minR = Infinity;
      }
      if (isC) {
        const r = 1 / Math.abs(kk);
        if (r < minR) {
          minR = r;
          apex = i;
        }
      } else if (inCorner) {
        flush(i);
        inCorner = false;
      }
    }
    this.corners.sort((a, b) => a.start - b.start);
  }

  private buildRunoffAndCurbs(): void {
    const n = this.n;
    const sp = this.spacing;
    const d = this.def;
    const baseT = RUNOFF_CODE[d.runoffType];
    const cornerT = RUNOFF_CODE[d.cornerRunoffType];
    const extraL = new Float64Array(n);
    const extraR = new Float64Array(n);
    const typeOutL = new Uint8Array(n).fill(255);
    const typeOutR = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) {
      this.runL[i] = d.runoff;
      this.runR[i] = d.runoff;
      this.runTypeL[i] = baseT;
      this.runTypeR[i] = baseT;
      const o = d.segs[this.segOf[i]].o;
      if (o.ro !== undefined) {
        this.runL[i] = o.ro;
        this.runR[i] = o.ro;
      }
      if (o.roT) {
        this.runTypeL[i] = RUNOFF_CODE[o.roT];
        this.runTypeR[i] = RUNOFF_CODE[o.roT];
      }
    }
    for (const c of this.corners) {
      const len = mod(c.end - c.start, n);
      const sharp = c.minRadius < 260;
      // Curbs innen (Scheitel) und außen (Ein- und Ausgang)
      const inStart = c.start + Math.floor(len * 0.15) - 3;
      const inEnd = c.start + Math.ceil(len * 0.85) + 3;
      for (let j = inStart; j <= inEnd; j++) {
        const i = mod(j, n);
        if (c.dir > 0) this.curbL[i] = 1;
        else this.curbR[i] = 1;
      }
      if (sharp) {
        const outStart = c.start + Math.floor(len * 0.55);
        const outEnd = c.end + Math.round(22 / sp);
        for (let j = outStart; j <= outEnd; j++) {
          const i = mod(j, n);
          if (c.dir > 0) this.curbR[i] = 1;
          else this.curbL[i] = 1;
        }
        const entStart = c.start - Math.round(14 / sp);
        const entEnd = c.start + Math.floor(len * 0.2);
        for (let j = entStart; j <= entEnd; j++) {
          const i = mod(j, n);
          if (c.dir > 0) this.curbR[i] = 1;
          else this.curbL[i] = 1;
        }
        // Größerer Auslauf außen, besonders am Kurvenausgang
        const ex0 = c.start - Math.round(40 / sp);
        const ex1 = c.end + Math.round(60 / sp);
        const total = ex1 - ex0;
        const extra = d.cornerRunoff * clamp(140 / Math.max(c.minRadius, 25), 0.45, 1.4);
        for (let j = ex0; j <= ex1; j++) {
          const i = mod(j, n);
          const f = (j - ex0) / total;
          const env = smoothstep(0, 0.25, f) * (1 - smoothstep(0.8, 1, f));
          const v = extra * env;
          const o = d.segs[this.segOf[i]].o;
          if (o.ro !== undefined) continue;
          if (c.dir > 0) {
            if (v > extraR[i]) extraR[i] = v;
            if (env > 0.3) typeOutR[i] = cornerT;
          } else {
            if (v > extraL[i]) extraL[i] = v;
            if (env > 0.3) typeOutL[i] = cornerT;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      this.runL[i] += extraL[i];
      this.runR[i] += extraR[i];
      if (typeOutL[i] !== 255) this.runTypeL[i] = typeOutL[i];
      if (typeOutR[i] !== 255) this.runTypeR[i] = typeOutR[i];
      this.barL[i] = this.halfW[i] + (this.curbL[i] ? CURB_WIDTH : 0.4) + this.runL[i];
      this.barR[i] = this.halfW[i] + (this.curbR[i] ? CURB_WIDTH : 0.4) + this.runR[i];
    }
    // Barrieren glätten, damit keine Zacken entstehen
    const bl = boxSmooth(Float64Array.from(this.barL), Math.round(10 / sp));
    const br = boxSmooth(Float64Array.from(this.barR), Math.round(10 / sp));
    for (let i = 0; i < n; i++) {
      this.barL[i] = Math.max(bl[i], this.halfW[i] + (this.curbL[i] ? CURB_WIDTH + 0.6 : 1.0));
      this.barR[i] = Math.max(br[i], this.halfW[i] + (this.curbR[i] ? CURB_WIDTH + 0.6 : 1.0));
    }
  }

  private buildPit(): PitLane {
    const L = this.length;
    const side: 1 | -1 = this.def.pit.side === 'L' ? 1 : -1;
    const sEntry = mod(-this.def.pit.entry, L);
    const sExit = mod(this.def.pit.exit, L);
    const wallStartOff = Math.min(110, this.def.pit.entry * 0.45);
    const wallEndOff = Math.min(110, this.def.pit.exit * 0.45);
    const sWallStart = mod(-this.def.pit.entry + wallStartOff, L);
    const sWallEnd = mod(this.def.pit.exit - wallEndOff, L);
    const hw = this.halfW[0];
    const wallD = hw + 3.2;
    const laneCenter = wallD + 4.2;
    const boxLane = wallD + 9.5;
    const outerD = wallD + 13;
    // Boxen gleichmäßig zwischen Mauerstart und -ende verteilen
    const boxes: number[] = [];
    const span = this.def.pit.entry - wallStartOff + this.def.pit.exit - wallEndOff;
    for (let t = 0; t < 11; t++) {
      const off = -this.def.pit.entry + wallStartOff + span * ((t + 0.5) / 11);
      boxes.push(mod(off, L));
    }
    const pit: PitLane = {
      side,
      sEntry,
      sWallStart,
      sWallEnd,
      sExit,
      wallD,
      laneCenter,
      boxLane,
      outerD,
      speedLimit: 80 / 3.6,
      boxes,
    };
    // Barriere auf der Boxenseite im Boxenbereich nach außen schieben, Belag = Asphalt
    for (let i = 0; i < this.n; i++) {
      const s = i * this.spacing;
      if (!this.inRange(s, sEntry, sExit)) continue;
      if (side > 0) {
        this.barL[i] = Math.max(this.barL[i], outerD);
        this.runTypeL[i] = SURF_PIT;
        this.curbL[i] = 0;
      } else {
        this.barR[i] = Math.max(this.barR[i], outerD);
        this.runTypeR[i] = SURF_PIT;
        this.curbR[i] = 0;
      }
    }
    return pit;
  }

  /** Barrieren so begrenzen, dass sie nicht in benachbarte Streckenabschnitte ragen. */
  private clampBarriers(): void {
    const n = this.n;
    const sp = this.spacing;
    const L = this.length;
    const minGapS = 160;
    const reach = 4;
    for (let i = 0; i < n; i++) {
      const xi = this.px[i];
      const zi = this.pz[i];
      const cx = Math.floor(xi / this.cell);
      const cz = Math.floor(zi / this.cell);
      let maxL = this.barL[i];
      let maxR = this.barR[i];
      for (let gx = -reach; gx <= reach; gx++) {
        for (let gz = -reach; gz <= reach; gz++) {
          const arr = this.grid.get(cellKey(cx + gx, cz + gz));
          if (!arr) continue;
          for (const j of arr) {
            let ds = Math.abs(i - j) * sp;
            if (ds > L / 2) ds = L - ds;
            if (ds < minGapS) continue;
            if (Math.abs(this.py[i] - this.py[j]) > 4.5) continue;
            const rx = this.px[j] - xi;
            const rz = this.pz[j] - zi;
            const along = rx * this.tx[i] + rz * this.tz[i];
            if (Math.abs(along) > 14) continue;
            const lat = rx * this.nx[i] + rz * this.nz[i];
            const absLat = Math.abs(lat);
            const hwI = this.halfW[i];
            const hwJ = this.effHalfWidthToward(j, xi, zi);
            let wall = hwI + (absLat - hwI - hwJ) * 0.5 - 0.35;
            const minWall = hwI + 1.2;
            if (wall < minWall) {
              if (absLat - hwJ < hwI + 0.5) this.warnings.push(`Abschnitte zu nah bei s=${(i * sp).toFixed(0)}m`);
              wall = minWall;
            }
            if (lat > 0) maxL = Math.min(maxL, wall);
            else maxR = Math.min(maxR, wall);
          }
        }
      }
      this.barL[i] = maxL;
      this.barR[i] = maxR;
    }
    // Leicht glätten (nur nach unten), damit keine Spitzen entstehen
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const a = mod(i - 1, n);
        const b = (i + 1) % n;
        this.barL[i] = Math.min(this.barL[i], Math.max(this.barL[a], this.barL[b]) );
        this.barR[i] = Math.min(this.barR[i], Math.max(this.barR[a], this.barR[b]) );
      }
    }
  }

  /** Halbe belegte Breite eines Samples in Richtung eines Punktes (inkl. Boxengasse). */
  private effHalfWidthToward(j: number, x: number, z: number): number {
    let hw = this.halfW[j] + 1.5;
    const p = this.pit;
    if (p && this.inRange(j * this.spacing, p.sEntry, p.sExit)) {
      const latJ = (x - this.px[j]) * this.nx[j] + (z - this.pz[j]) * this.nz[j];
      if (Math.sign(latJ) === p.side) hw = Math.max(hw, p.outerD + 2);
    }
    return hw;
  }

  // ------------------------------------------------------------------ Abfragen

  inRange(s: number, a: number, b: number): boolean {
    s = mod(s, this.length);
    return a <= b ? s >= a && s <= b : s >= a || s <= b;
  }

  wrapS(s: number): number {
    return mod(s, this.length);
  }

  /** Vorzeichenbehaftete Differenz b - a entlang der Strecke im Bereich (-L/2, L/2]. */
  deltaS(a: number, b: number): number {
    let d = b - a;
    const L = this.length;
    d = mod(d + L / 2, L) - L / 2;
    return d;
  }

  indexAt(s: number): number {
    return mod(Math.floor(s / this.spacing), this.n);
  }

  /** Interpoliert ein Feld an Position s. */
  sampleField(arr: ArrayLike<number>, s: number): number {
    const f = mod(s, this.length) / this.spacing;
    const i = Math.floor(f);
    const t = f - i;
    const a = arr[i % this.n];
    const b = arr[(i + 1) % this.n];
    return a + (b - a) * t;
  }

  /** Weltposition (x,y,z) und Richtung für (s, d). */
  pointAt(s: number, d: number, out: { x: number; y: number; z: number; tx: number; tz: number }) {
    const f = mod(s, this.length) / this.spacing;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const t = f - Math.floor(f);
    const x = this.px[i] + (this.px[j] - this.px[i]) * t;
    const z = this.pz[i] + (this.pz[j] - this.pz[i]) * t;
    let tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t;
    let tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    const nx = tz;
    const nz = -tx;
    out.x = x + nx * d;
    out.z = z + nz * d;
    out.y = this.heightAt(s, d);
    out.tx = tx;
    out.tz = tz;
    return out;
  }

  /** Oberflächenhöhe an (s, d) inkl. Banking. */
  heightAt(s: number, d: number): number {
    const y = this.sampleField(this.py, s);
    const b = this.sampleField(this.bank, s);
    const hw = this.sampleField(this.halfW, s);
    const dc = clamp(d, -hw - 6, hw + 6);
    return y + Math.tan(b) * dc;
  }

  /** Belagsart an (s, d). */
  surfaceAt(s: number, d: number): number {
    const i = this.indexAt(s);
    const hw = this.halfW[i];
    const ad = Math.abs(d);
    if (ad <= hw) return SURF_ASPHALT;
    const left = d > 0;
    const curb = left ? this.curbL[i] : this.curbR[i];
    if (curb && ad <= hw + CURB_WIDTH) return SURF_CURB;
    const p = this.pit;
    const pitSide = (left ? 1 : -1) === p.side;
    if (pitSide && this.inRange(s, p.sEntry, p.sExit)) return SURF_PIT;
    if (ad <= hw + 0.6) return SURF_RUNOFF_ASPHALT; // weiße Linie / Randstreifen
    return left ? this.runTypeL[i] : this.runTypeR[i];
  }

  barrierAt(s: number, left: boolean): number {
    return this.sampleField(left ? this.barL : this.barR, s);
  }

  /**
   * Projiziert einen Punkt auf die Mittellinie. Nutzt einen Index-Hinweis für lokale Suche;
   * hint < 0 erzwingt globale Suche (mit Höhen-Disambiguierung über y).
   */
  project(x: number, z: number, hint: number, out: Projection, y = NaN): Projection {
    const n = this.n;
    let best = -1;
    let bestD2 = Infinity;
    if (hint >= 0) {
      let center = hint % n;
      // lokale Suche mit wanderndem Fenster
      for (let iter = 0; iter < 8; iter++) {
        let localBest = center;
        let localD2 = Infinity;
        for (let k = -14; k <= 14; k++) {
          const j = mod(center + k, n);
          const dx = x - this.px[j];
          const dz = z - this.pz[j];
          const d2 = dx * dx + dz * dz;
          if (d2 < localD2) {
            localD2 = d2;
            localBest = j;
          }
        }
        best = localBest;
        bestD2 = localD2;
        const off = Math.abs(this.deltaIdx(center, localBest));
        if (off < 12) break;
        center = localBest;
      }
      // Plausibilitätscheck: Weit weg -> globale Suche
      if (bestD2 > 120 * 120) best = -1;
    }
    if (best < 0) {
      for (let j = 0; j < n; j++) {
        const dx = x - this.px[j];
        const dz = z - this.pz[j];
        let d2 = dx * dx + dz * dz;
        if (!Number.isNaN(y)) {
          const dy = y - this.py[j];
          d2 += dy * dy * 16;
        }
        if (d2 < bestD2) {
          bestD2 = d2;
          best = j;
        }
      }
    }
    // Verfeinerung auf den benachbarten Segmenten
    const a = mod(best - 1, n);
    const b = best;
    const c = (best + 1) % n;
    const r1 = this.segProject(x, z, a, b);
    const r2 = this.segProject(x, z, b, c);
    const r = r1.d2 < r2.d2 ? r1 : r2;
    const i0 = r === r1 ? a : b;
    const i1 = r === r1 ? b : c;
    const t = r.t;
    let tx = this.tx[i0] + (this.tx[i1] - this.tx[i0]) * t;
    let tz = this.tz[i0] + (this.tz[i1] - this.tz[i0]) * t;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const cxp = this.px[i0] + (this.px[i1] - this.px[i0]) * t;
    const czp = this.pz[i0] + (this.pz[i1] - this.pz[i0]) * t;
    const d = (x - cxp) * tz + (z - czp) * -tx;
    out.i = i0;
    out.s = mod((i0 + t) * this.spacing, this.length);
    out.d = d;
    out.tx = tx;
    out.tz = tz;
    out.y = this.heightAt(out.s, d);
    out.dist2 = r.d2;
    return out;
  }

  private deltaIdx(a: number, b: number): number {
    const n = this.n;
    let d = b - a;
    d = mod(d + n / 2, n) - n / 2;
    return d;
  }

  private segProject(x: number, z: number, i0: number, i1: number) {
    const ax = this.px[i0];
    const az = this.pz[i0];
    const bx = this.px[i1] - ax;
    const bz = this.pz[i1] - az;
    const l2 = bx * bx + bz * bz || 1;
    const t = clamp(((x - ax) * bx + (z - az) * bz) / l2, 0, 1);
    const dx = x - (ax + bx * t);
    const dz = z - (az + bz * t);
    return { t, d2: dx * dx + dz * dz };
  }

  /** Nächster Streckenpunkt (Index, Distanz) zu (x,z) über das Raster – für Szenerie-Platzierung. */
  nearest(x: number, z: number, maxDist = 200): { i: number; dist: number } {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const reach = Math.ceil(maxDist / this.cell);
    let best = -1;
    let bestD2 = maxDist * maxDist;
    for (let gx = -reach; gx <= reach; gx++) {
      for (let gz = -reach; gz <= reach; gz++) {
        const arr = this.grid.get(cellKey(cx + gx, cz + gz));
        if (!arr) continue;
        for (const j of arr) {
          const dx = x - this.px[j];
          const dz = z - this.pz[j];
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = j;
          }
        }
      }
    }
    return { i: best, dist: best < 0 ? Infinity : Math.sqrt(bestD2) };
  }

  /** Alle Samples innerhalb eines Radius (für Gelände unter Brücken etc.). */
  forEachNear(x: number, z: number, radius: number, fn: (i: number, d2: number) => void): void {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const reach = Math.ceil(radius / this.cell);
    const r2 = radius * radius;
    for (let gx = -reach; gx <= reach; gx++) {
      for (let gz = -reach; gz <= reach; gz++) {
        const arr = this.grid.get(cellKey(cx + gx, cz + gz));
        if (!arr) continue;
        for (const j of arr) {
          const dx = x - this.px[j];
          const dz = z - this.pz[j];
          const d2 = dx * dx + dz * dz;
          if (d2 < r2) fn(j, d2);
        }
      }
    }
  }

  /** Startplatz k (0 = Pole): s und seitlicher Versatz. */
  gridSlot(k: number): { s: number; d: number } {
    const s = this.wrapS(-7 - k * 8);
    const hw = this.sampleField(this.halfW, s);
    const off = Math.min(2.6, hw - 1.6);
    const d = (k % 2 === 0 ? 1 : -1) * off * (this.pit.side > 0 ? -1 : 1);
    return { s, d };
  }

  /** Pfad (seitlicher Versatz) für Fahrten durch die Boxengasse. */
  pitPathD(s: number, toBox: number | null): number {
    const p = this.pit;
    const L = this.length;
    const rel = (v: number) => this.deltaS(p.sEntry, v);
    const span = rel(p.sExit);
    const x = rel(s);
    const xWs = rel(p.sWallStart);
    const xWe = rel(p.sWallEnd);
    let target = p.laneCenter;
    if (toBox !== null) {
      const xb = rel(toBox);
      const near = 1 - smoothstep(10, 45, Math.abs(x - xb));
      target = p.laneCenter + (p.boxLane - p.laneCenter) * near;
    }
    let d: number;
    if (x < 0 || x > span) d = 0;
    else if (x < xWs) d = this.halfW[0] * 0.6 + (target - this.halfW[0] * 0.6) * smoothstep(0, xWs * 0.85, x);
    else if (x > xWe) d = p.laneCenter * (1 - smoothstep(xWe + (span - xWe) * 0.15, span, x));
    else d = target;
    void L;
    return d * p.side;
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

/** Zyklischer gleitender Mittelwert mit Halbfensterbreite r. */
export function boxSmooth(src: Float64Array, r: number): Float64Array {
  const n = src.length;
  if (r <= 0) return Float64Array.from(src);
  const out = new Float64Array(n);
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += src[mod(k, n)];
  const w = 2 * r + 1;
  for (let i = 0; i < n; i++) {
    out[i] = sum / w;
    sum += src[mod(i + r + 1, n)] - src[mod(i - r, n)];
  }
  return out;
}

interface RawResult {
  points: RawPoint[];
  length: number;
  segLen: number[];
}

/** Löst Auto-Längen/-Winkel und erzeugt eine fein abgetastete Krümmungsbeschreibung. */
function buildRaw(def: TrackDef): RawResult {
  const segs = def.segs;
  const targetTurn = def.dir === 'cw' ? -360 : def.dir === 'ccw' ? 360 : 0;
  // Winkel lösen
  let fixedTurn = 0;
  let autoAngIdx = -1;
  segs.forEach((s, i) => {
    if (s.k === 'C') {
      if (s.o.autoAng) autoAngIdx = i;
      else fixedTurn += s.ang;
    }
  });
  const angles = segs.map((s) => (s.k === 'C' ? s.ang : 0));
  if (autoAngIdx >= 0) {
    angles[autoAngIdx] = targetTurn - fixedTurn;
  }
  // Längen lösen: Verschiebung aller festen Segmente + zwei Auto-Geraden = 0
  const th0 = (def.startHeading * Math.PI) / 180;
  let th = th0;
  let dx = 0;
  let dz = 0;
  const autoDirs: { i: number; x: number; z: number }[] = [];
  segs.forEach((s, i) => {
    if (s.k === 'S') {
      if (s.o.auto) autoDirs.push({ i, x: Math.sin(th), z: Math.cos(th) });
      else {
        dx += Math.sin(th) * s.len;
        dz += Math.cos(th) * s.len;
      }
    } else {
      const a = (angles[i] * Math.PI) / 180;
      const k = Math.sign(a) / s.r;
      // Kreisbogen: Sehne
      const th1 = th + a;
      if (Math.abs(k) > 0) {
        // Integral von (sin th, cos th) ds mit th = th0 + k s
        dx += (-Math.cos(th1) + Math.cos(th)) / k;
        dz += (Math.sin(th1) - Math.sin(th)) / k;
      }
      th = th1;
    }
  });
  const lens = segs.map((s) => (s.k === 'S' ? s.len : (Math.abs(angles[segs.indexOf(s)]) * Math.PI / 180) * s.r));
  if (autoDirs.length === 2) {
    const [a, b] = autoDirs;
    // a.x*La + b.x*Lb = -dx ; a.z*La + b.z*Lb = -dz
    const det = a.x * b.z - b.x * a.z;
    if (Math.abs(det) > 1e-6) {
      const La = (-dx * b.z + b.x * dz) / det;
      const Lb = (a.x * -dz + dx * a.z) / det;
      lens[a.i] = La;
      lens[b.i] = Lb;
    }
  }
  segs.forEach((s, i) => {
    if (s.k === 'C') lens[i] = (Math.abs(angles[i]) * Math.PI / 180) * s.r;
  });
  // Feine Abtastung
  const pts: RawPoint[] = [];
  let sAcc = 0;
  let w = def.width;
  let bank = 0;
  let thAcc = 0;
  segs.forEach((s, i) => {
    const len = Math.max(0.5, lens[i]);
    if (s.o.w !== undefined) w = s.o.w;
    bank = s.o.bank ?? 0;
    const k = s.k === 'C' ? Math.sign(angles[i]) / s.r : 0;
    const steps = Math.max(1, Math.ceil(len / 0.5));
    for (let j = 0; j < steps; j++) {
      const ds = (j / steps) * len;
      pts.push({ s: sAcc + ds, th: thAcc + k * ds, k, w, bank, seg: i });
    }
    sAcc += len;
    thAcc += k * len;
  });
  pts.push({ ...pts[0], s: sAcc, th: thAcc, k: 0 });
  return { points: pts, length: sAcc, segLen: lens };
}

/** Diagnose-Informationen zur Turtle-Auflösung (für Tools/Tests). */
export function describeRaw(def: TrackDef): { rawLength: number; segLen: number[] } {
  const r = buildRaw(def);
  return { rawLength: r.length, segLen: r.segLen };
}
