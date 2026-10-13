// Spieleinstellungen inkl. Laden/Speichern im localStorage.
import type { Weather } from './shared/carPhysics';
import { type AssistSettings, type Difficulty, getDifficulty, sanitizeAssists, type StartMode } from './sim/config';

export type Action =
  | 'throttle'
  | 'brake'
  | 'left'
  | 'right'
  | 'handbrake'
  | 'shiftUp'
  | 'shiftDown'
  | 'camera'
  | 'reset'
  | 'pause'
  | 'lookBack';

export const ACTION_LABELS: Record<Action, string> = {
  throttle: 'Gas',
  brake: 'Bremse',
  left: 'Links lenken',
  right: 'Rechts lenken',
  handbrake: 'Handbremse (Hinterachse)',
  shiftUp: 'Hochschalten',
  shiftDown: 'Runterschalten',
  camera: 'Kamera wechseln',
  reset: 'Fahrzeug zurücksetzen',
  pause: 'Pause',
  lookBack: 'Rückblick',
};

export type Bindings = Record<Action, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  shiftUp: ['ShiftLeft'],
  shiftDown: ['ControlLeft'],
  camera: ['KeyC'],
  reset: ['KeyR'],
  pause: ['Escape'],
  lookBack: ['KeyB'],
};

export type CameraMode = 'tv' | 'close' | 'far' | 'cockpit' | 'front' | 'trackside';
export const CAMERA_MODES: { id: CameraMode; name: string }[] = [
  { id: 'tv', name: 'TV-Kamera (hinter dem Fahrzeug)' },
  { id: 'close', name: 'Nah hinter dem Fahrzeug' },
  { id: 'far', name: 'Weit hinter dem Fahrzeug' },
  { id: 'cockpit', name: 'Cockpit' },
  { id: 'front', name: 'Frontkamera (Nase)' },
  { id: 'trackside', name: 'Verfolger / Streckenkameras' },
];

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  version: number;
  playerName: string;
  difficulty: Difficulty;
  transmission: 'auto' | 'manual';
  assists: AssistSettings;
  graphics: { quality: Quality; showFps: boolean };
  controls: { steerSensitivity: number; steerLinearity: number; deadzone: number; vibration: boolean; bindings: Bindings };
  audio: { master: number; engine: number; ambient: number; effects: number };
  camera: { mode: CameraMode; fov: number; shake: boolean };
  race: {
    driverId: string;
    trackId: string;
    laps: number;
    aiCount: number;
    weather: Weather;
    wearScale: number;
    startMode: StartMode;
  };
  firstRunDone: boolean;
  serverUrl: string;
}

const KEY = 'apex-gp-settings-v1';

export function defaultSettings(): Settings {
  return {
    version: 1,
    playerName: 'Spieler',
    difficulty: 'normal',
    transmission: 'auto',
    assists: { ...getDifficulty('normal').defaults },
    graphics: { quality: 'medium', showFps: false },
    controls: { steerSensitivity: 1, steerLinearity: 1.3, deadzone: 0.08, vibration: true, bindings: structuredClone(DEFAULT_BINDINGS) },
    audio: { master: 0.8, engine: 0.8, ambient: 0.6, effects: 0.8 },
    camera: { mode: 'tv', fov: 62, shake: true },
    race: { driverId: 'leclerc', trackId: 'silverstone', laps: 5, aiCount: 19, weather: 'dry', wearScale: 1, startMode: 'qualifying' },
    firstRunDone: false,
    serverUrl: '',
  };
}

function mergeDeep<T>(base: T, over: unknown): T {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) {
    return (over === undefined || typeof over !== typeof base ? base : (over as T));
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  if (typeof over === 'object' && over !== null) {
    for (const k of Object.keys(out)) {
      const bv = out[k];
      const ov = (over as Record<string, unknown>)[k];
      if (ov === undefined) continue;
      if (Array.isArray(bv)) out[k] = Array.isArray(ov) ? ov.filter((x) => typeof x === 'string') : bv;
      else out[k] = mergeDeep(bv, ov);
    }
  }
  return out as T;
}

export class SettingsStore {
  data: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor() {
    this.data = defaultSettings();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.data = mergeDeep(defaultSettings(), JSON.parse(raw));
    } catch {
      // Defekte oder nicht verfügbare Speicherung: Standardwerte verwenden
    }
    this.data.assists = sanitizeAssists(this.data.assists, this.data.difficulty);
  }

  save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // ignorieren (z. B. privater Modus)
    }
    for (const l of this.listeners) l(this.data);
  }

  update(fn: (s: Settings) => void): void {
    fn(this.data);
    this.data.assists = sanitizeAssists(this.data.assists, this.data.difficulty);
    this.save();
  }

  setDifficulty(d: Difficulty): void {
    this.data.difficulty = d;
    this.data.assists = { ...getDifficulty(d).defaults };
    this.save();
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  reset(): void {
    const keepName = this.data.playerName;
    this.data = defaultSettings();
    this.data.playerName = keepName;
    this.data.firstRunDone = true;
    this.save();
  }
}

// ---------------------------------------------------------------- Bestzeiten (Zeitfahren)

const BEST_KEY = 'apex-gp-besttimes-v1';

export interface BestLapRecord {
  time: number;
  sectors: (number | null)[];
  driverId: string;
  date: number;
  ghost?: number[];
}

export function loadBestLaps(): Record<string, BestLapRecord> {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveBestLap(trackId: string, rec: BestLapRecord): void {
  const all = loadBestLaps();
  all[trackId] = rec;
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {
    // Speicher voll: Geisterdaten weglassen
    try {
      delete rec.ghost;
      all[trackId] = rec;
      localStorage.setItem(BEST_KEY, JSON.stringify(all));
    } catch {
      /* ignorieren */
    }
  }
}

export function keyLabel(code: string): string {
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Leertaste',
    ShiftLeft: 'Shift links',
    ShiftRight: 'Shift rechts',
    ControlLeft: 'Strg links',
    ControlRight: 'Strg rechts',
    AltLeft: 'Alt',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: '⌫',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
