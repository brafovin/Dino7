// Zeit-über-Distanz-Aufzeichnung einer Runde: Delta-Anzeige und Geisterauto im Zeitfahren.
import { wrapAngle } from '../shared/math';

/** Zeit über Distanz einer Runde (für Delta-Anzeige und Geisterauto). */
export class LapTrace {
  s: number[] = [];
  t: number[] = [];
  pos: number[] = [];
  add(s: number, t: number, x: number, y: number, z: number, heading: number): void {
    if (this.s.length && s <= this.s[this.s.length - 1]) return;
    this.s.push(s);
    this.t.push(t);
    this.pos.push(x, y, z, heading);
  }
  timeAt(s: number): number | null {
    const S = this.s;
    if (S.length < 2 || s < S[0] || s > S[S.length - 1]) return null;
    let lo = 0;
    let hi = S.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (S[m] <= s) lo = m;
      else hi = m;
    }
    const f = (s - S[lo]) / Math.max(1e-6, S[hi] - S[lo]);
    return this.t[lo] + (this.t[hi] - this.t[lo]) * f;
  }
  /** Position zum Zeitpunkt t (Geisterauto). */
  poseAt(t: number, out: number[]): boolean {
    const T = this.t;
    if (T.length < 2 || t < T[0] || t > T[T.length - 1]) return false;
    let lo = 0;
    let hi = T.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (T[m] <= t) lo = m;
      else hi = m;
    }
    const f = (t - T[lo]) / Math.max(1e-6, T[hi] - T[lo]);
    const P = this.pos;
    for (let k = 0; k < 3; k++) out[k] = P[lo * 4 + k] + (P[hi * 4 + k] - P[lo * 4 + k]) * f;
    out[3] = P[lo * 4 + 3] + wrapAngle(P[hi * 4 + 3] - P[lo * 4 + 3]) * f;
    return true;
  }
  serialize(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.s.length; i++) out.push(+this.s[i].toFixed(1), +this.t[i].toFixed(3), +this.pos[i * 4].toFixed(2), +this.pos[i * 4 + 1].toFixed(2), +this.pos[i * 4 + 2].toFixed(2), +this.pos[i * 4 + 3].toFixed(3));
    return out;
  }
  static from(arr: number[]): LapTrace {
    const tr = new LapTrace();
    for (let i = 0; i + 5 < arr.length; i += 6) tr.add(arr[i], arr[i + 1], arr[i + 2], arr[i + 3], arr[i + 4], arr[i + 5]);
    return tr;
  }
}

