// Kleine, abhängigkeitsfreie Mathe-Helfer, die Client, Server und Tests teilen.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const saturate = (v: number): number => clamp(v, 0, 1);
export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const DEG = Math.PI / 180;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Normalisiert einen Winkel auf (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Positiver Modulo (auch für negative Werte). */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Bewegt einen Wert mit maximaler Rate auf ein Ziel zu. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

/** Exponentielle, framerate-unabhängige Glättung. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Deterministischer Pseudozufallsgenerator (Mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Formatiert Sekunden als m:ss.mmm */
export function formatTime(t: number | null | undefined, withMinutes = true): string {
  if (t === null || t === undefined || !isFinite(t) || t < 0) return '--:--.---';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return withMinutes || m > 0 ? `${m}:${ss}` : ss;
}

export function formatGap(t: number): string {
  const sgn = t < 0 ? '-' : '+';
  return `${sgn}${Math.abs(t).toFixed(3)}`;
}
