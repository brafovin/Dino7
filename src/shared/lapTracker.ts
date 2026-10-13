// Runden- und Sektorerkennung mit Zeitinterpolation. Wird von Einzelspieler-Sitzungen und dem
// Multiplayer-Server (serverseitige Rundenwertung) gleichermaßen genutzt.

export type LapEvent =
  | { type: 'sector'; sector: 0 | 1; time: number; split: number }
  | { type: 'lap'; lap: number; time: number; lapTime: number; sector3: number; valid: boolean }
  | { type: 'cross-start'; time: number };

export class LapTracker {
  readonly length: number;
  readonly cps: [number, number];
  /** Abgeschlossene Runden */
  completed = 0;
  /** Vor der ersten Zieldurchfahrt (Startaufstellung / Outlap) */
  preLine = true;
  /** Nächster Kontrollpunkt: 0 = Sektor 1, 1 = Sektor 2, 2 = Ziellinie */
  nextCp: 0 | 1 | 2 = 2;
  /** Zeitnahme läuft (Rennen: ab Start; Zeitfahren: ab erster Zieldurchfahrt) */
  timing = false;
  lapStart = 0;
  sectorStart = 0;
  curSectors: (number | null)[] = [null, null, null];
  lastSectors: (number | null)[] = [null, null, null];
  bestSectors: (number | null)[] = [null, null, null];
  lastLap: number | null = null;
  bestLap: number | null = null;
  lapTimes: number[] = [];
  invalid = false;
  finished = false;
  finishTime: number | null = null;

  constructor(length: number, s1: number, s2: number) {
    this.length = length;
    this.cps = [s1, s2];
  }

  /** Rennstart: Zeitnahme ab Startsignal, erste Zieldurchfahrt zählt nicht als Runde. */
  startRace(time: number): void {
    this.timing = true;
    this.lapStart = time;
    this.sectorStart = time;
    this.preLine = true;
    this.nextCp = 2;
    this.completed = 0;
  }

  /** Fortschritt in Metern (für Positionsberechnung). */
  progress(s: number): number {
    const base = this.completed * this.length;
    if (this.preLine) return base + (s > this.length * 0.5 ? s - this.length : s);
    return base + s;
  }

  currentLapTime(now: number): number | null {
    return this.timing ? now - this.lapStart : null;
  }

  private deltaS(a: number, b: number): number {
    const L = this.length;
    let d = (b - a) % L;
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    return d;
  }

  /** Verarbeitet eine Bewegung von sPrev nach sNew im Zeitraum tPrev..tNew. */
  update(sPrev: number, sNew: number, tPrev: number, tNew: number, out: LapEvent[] = []): LapEvent[] {
    const ds = this.deltaS(sPrev, sNew);
    if (ds === 0 || this.finished) return out;
    const at = (c: number) => tPrev + (this.deltaS(sPrev, c) / ds) * (tNew - tPrev);
    const crosses = (c: number) => {
      const dc = this.deltaS(sPrev, c);
      return ds > 0 ? dc > 0 && dc <= ds : dc <= 0 && dc > ds;
    };
    if (ds < 0) {
      // Rückwärts über die Ziellinie: Durchfahrt muss wiederholt werden
      if (crosses(0) && !this.preLine && this.nextCp === 0) {
        this.preLine = true;
        this.nextCp = 2;
      }
      return out;
    }
    if (this.nextCp < 2) {
      const c = this.cps[this.nextCp as 0 | 1];
      if (crosses(c)) {
        const t = at(c);
        const idx = this.nextCp as 0 | 1;
        const split = t - this.sectorStart;
        if (this.timing) {
          this.curSectors[idx] = split;
          out.push({ type: 'sector', sector: idx, time: t, split });
        }
        this.sectorStart = t;
        this.nextCp = idx === 0 ? 1 : 2;
      }
    }
    if (this.nextCp === 2 && crosses(0)) {
      const t = at(0);
      if (this.preLine) {
        this.preLine = false;
        if (!this.timing) {
          this.timing = true;
          this.lapStart = t;
          this.invalid = false;
        }
        this.sectorStart = t;
        out.push({ type: 'cross-start', time: t });
      } else {
        const lapTime = t - this.lapStart;
        const s3 = t - this.sectorStart;
        this.curSectors[2] = s3;
        this.completed++;
        const valid = !this.invalid;
        this.lapTimes.push(lapTime);
        this.lastLap = lapTime;
        this.lastSectors = this.curSectors.slice();
        if (valid) {
          if (this.bestLap === null || lapTime < this.bestLap) this.bestLap = lapTime;
          for (let k = 0; k < 3; k++) {
            const v = this.curSectors[k];
            if (v !== null && (this.bestSectors[k] === null || v < (this.bestSectors[k] as number))) this.bestSectors[k] = v;
          }
        }
        out.push({ type: 'lap', lap: this.completed, time: t, lapTime, sector3: s3, valid });
        this.lapStart = t;
        this.sectorStart = t;
        this.curSectors = [null, null, null];
        this.invalid = false;
      }
      this.nextCp = 0;
    }
    return out;
  }
}
