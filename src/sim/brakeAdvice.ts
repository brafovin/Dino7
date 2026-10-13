// Bremshinweis: berechnet aus dem Geschwindigkeitsprofil des Spielers, wo er bei seiner aktuellen
// Geschwindigkeit spätestens anbremsen muss und mit welchem Tempo die nächste Kurve gefahren wird.
import type { Track } from '../shared/track';

export interface BrakeAdvice {
  /** Strecke (m) bis zum Bremspunkt; ≤ 0 = jetzt bremsen */
  dist: number;
  /** s-Position des Bremspunkts */
  sBrake: number;
  /** s-Position der langsamsten Stelle (Kurvenscheitel) */
  sApex: number;
  /** Zielgeschwindigkeit am Scheitel (m/s) */
  vTarget: number;
  /** deutliches Anbremsen (sonst nur Gas wegnehmen) */
  strong: boolean;
}

/** Mindest-Geschwindigkeitsabbau (m/s), ab dem überhaupt ein Hinweis erscheint */
const MIN_DROP = 4;
/** ab diesem Abbau (m/s) ist es ein echter Bremspunkt statt nur Lupfen */
const STRONG_DROP = 9;
/** Vorlauf (s): Reaktionszeit und Druckaufbau der Bremse – der Hinweis kommt so viel früher */
const LEAD_TIME = 0.25;

/**
 * Sucht vor dem Fahrzeug (Position s, Geschwindigkeit v) die erste Stelle, an der das Sollprofil
 * unter die aktuelle Geschwindigkeit fällt – dort beginnt die Bremszone für dieses Tempo.
 */
export function brakeAdvice(track: Track, profile: Float32Array, s: number, v: number, lookahead = 520): BrakeAdvice | null {
  if (!(v > 8)) return null;
  const n = track.n;
  const sp = track.spacing;
  const i0 = Math.floor(track.wrapS(s) / sp);
  const steps = Math.min(n - 1, Math.ceil(lookahead / sp));
  let kBrake = -1;
  let vMin = Infinity;
  let kMin = -1;
  for (let k = 0; k <= steps; k++) {
    const vt = profile[(i0 + k) % n];
    if (kBrake < 0) {
      if (vt < v - 0.5) {
        kBrake = k;
        vMin = vt;
        kMin = k;
      }
      continue;
    }
    if (vt < vMin) {
      vMin = vt;
      kMin = k;
    } else if (vt > vMin + 3) {
      break; // Scheitel überschritten
    }
  }
  if (kBrake < 0 || v - vMin < MIN_DROP) return null;
  const sBrake = track.wrapS((i0 + kBrake) * sp - v * LEAD_TIME);
  const sApex = track.wrapS((i0 + kMin) * sp);
  return { dist: track.deltaS(s, sBrake), sBrake, sApex, vTarget: vMin, strong: v - vMin >= STRONG_DROP };
}

export interface BrakeState {
  advice: BrakeAdvice;
  /** aktuelle Distanz bis zum Bremspunkt (m); ≤ 0 = Bremszone erreicht */
  dist: number;
  /** Bremspunkt eingefroren (kurz vor dem Erreichen bzw. in der Bremszone) */
  latched: boolean;
}

/**
 * Hält den Bremspunkt kurz vor dem Erreichen fest, damit er beim Anbremsen nicht mit dem Auto
 * „mitwandert“, und gibt ihn erst nach dem Kurvenscheitel bzw. bei erreichtem Zieltempo frei.
 */
export class BrakeHintTracker {
  private latched: BrakeAdvice | null = null;

  reset(): void {
    this.latched = null;
  }

  update(track: Track, profile: Float32Array, s: number, v: number): BrakeState | null {
    if (this.latched) {
      const l = this.latched;
      const dist = track.deltaS(s, l.sBrake);
      const toApex = track.deltaS(s, l.sApex);
      if (toApex < -5 || v <= l.vTarget + 1 || dist > 600) this.latched = null;
      else return { advice: l, dist, latched: true };
    }
    const a = brakeAdvice(track, profile, s, v);
    if (!a) return null;
    if (a.dist < Math.max(25, v * 0.9)) {
      this.latched = a;
      return { advice: a, dist: a.dist, latched: true };
    }
    return { advice: a, dist: a.dist, latched: false };
  }
}
