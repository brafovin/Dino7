// Spielkonfiguration: Schwierigkeitsgrade, Fahrhilfen, Modi.
import type { Assists, Compound, Weather } from '../shared/carPhysics';

export type Difficulty = 'beginner' | 'easy' | 'normal' | 'hard' | 'expert';
export type TcLevel = 'off' | 'low' | 'high';
export type LineMode = 'off' | 'corners' | 'full';
export type GameMode = 'grandprix' | 'timetrial' | 'practice' | 'multiplayer';

export interface AssistSettings {
  tc: TcLevel;
  abs: boolean;
  line: LineMode;
  steering: boolean;
  brake: boolean;
  autoReset: boolean;
}

export interface DifficultyDef {
  id: Difficulty;
  name: string;
  description: string;
  /** Grip-Ausnutzung der KI (Anteil am physikalischen Limit) */
  aiGrip: number;
  aiRacecraft: number;
  /** Stabilitätsassistent für den Spieler 0..1 */
  stability: number;
  /** Erlaubte Fahrhilfen bei diesem Schwierigkeitsgrad */
  allowed: {
    tc: TcLevel[];
    abs: boolean[];
    line: LineMode[];
    steering: boolean[];
    brake: boolean[];
    autoReset: boolean[];
  };
  defaults: AssistSettings;
}

const ALL_TC: TcLevel[] = ['off', 'low', 'high'];
const ALL_LINE: LineMode[] = ['off', 'corners', 'full'];
const BOTH = [false, true];

export const DIFFICULTIES: DifficultyDef[] = [
  {
    id: 'beginner',
    name: 'Anfänger',
    description: 'Starke Fahrhilfen, Stabilitätsassistent, langsamere KI',
    aiGrip: 0.84,
    aiRacecraft: 0.4,
    stability: 0.9,
    allowed: { tc: ALL_TC, abs: BOTH, line: ALL_LINE, steering: BOTH, brake: BOTH, autoReset: BOTH },
    defaults: { tc: 'high', abs: true, line: 'full', steering: true, brake: true, autoReset: true },
  },
  {
    id: 'easy',
    name: 'Einfach',
    description: 'Großzügige Traktion, leichte Stabilisierung, moderate KI',
    aiGrip: 0.89,
    aiRacecraft: 0.55,
    stability: 0.45,
    allowed: { tc: ALL_TC, abs: BOTH, line: ALL_LINE, steering: BOTH, brake: BOTH, autoReset: BOTH },
    defaults: { tc: 'high', abs: true, line: 'full', steering: true, brake: false, autoReset: true },
  },
  {
    id: 'normal',
    name: 'Normal',
    description: 'Ausgewogene Fahrphysik und KI',
    aiGrip: 0.93,
    aiRacecraft: 0.7,
    stability: 0,
    allowed: { tc: ALL_TC, abs: BOTH, line: ALL_LINE, steering: BOTH, brake: BOTH, autoReset: BOTH },
    defaults: { tc: 'low', abs: true, line: 'corners', steering: false, brake: false, autoReset: true },
  },
  {
    id: 'hard',
    name: 'Schwer',
    description: 'Anspruchsvolle KI, kein Brems- und Lenkassistent',
    aiGrip: 0.96,
    aiRacecraft: 0.85,
    stability: 0,
    allowed: { tc: ALL_TC, abs: BOTH, line: ALL_LINE, steering: [false], brake: [false], autoReset: BOTH },
    defaults: { tc: 'low', abs: true, line: 'off', steering: false, brake: false, autoReset: false },
  },
  {
    id: 'expert',
    name: 'Experte',
    description: 'Sehr schnelle KI, nur TC (niedrig) und ABS erlaubt',
    aiGrip: 0.98,
    aiRacecraft: 1.0,
    stability: 0,
    allowed: { tc: ['off', 'low'], abs: BOTH, line: ['off'], steering: [false], brake: [false], autoReset: [false] },
    defaults: { tc: 'off', abs: false, line: 'off', steering: false, brake: false, autoReset: false },
  },
];

export function getDifficulty(id: Difficulty): DifficultyDef {
  return DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[2];
}

/** Erzwingt, dass die Fahrhilfen zum Schwierigkeitsgrad passen. */
export function sanitizeAssists(a: AssistSettings, diff: Difficulty): AssistSettings {
  const d = getDifficulty(diff);
  const pick = <T>(v: T, allowed: T[]): T => (allowed.includes(v) ? v : allowed[allowed.length - 1]);
  return {
    tc: d.allowed.tc.includes(a.tc) ? a.tc : d.allowed.tc[d.allowed.tc.length - 1],
    abs: pick(a.abs, d.allowed.abs),
    line: d.allowed.line.includes(a.line) ? a.line : d.allowed.line[d.allowed.line.length - 1],
    steering: pick(a.steering, d.allowed.steering),
    brake: pick(a.brake, d.allowed.brake),
    autoReset: pick(a.autoReset, d.allowed.autoReset),
  };
}

export function toPhysicsAssists(a: AssistSettings, diff: Difficulty, autoGear: boolean): Assists {
  return {
    tc: a.tc === 'off' ? 0 : a.tc === 'low' ? 1 : 2,
    abs: a.abs,
    steering: a.steering,
    autoGear,
    stability: getDifficulty(diff).stability,
  };
}

export type StartMode = 'qualifying' | 'random' | 'back' | 'pole';

export interface SessionConfig {
  mode: GameMode;
  trackId: string;
  laps: number;
  weather: Weather;
  difficulty: Difficulty;
  playerDriverId: string;
  aiCount: number;
  startMode: StartMode;
  /** Reifenverschleiß-Faktor (0 = aus) */
  wearScale: number;
  startCompound: Compound;
  transmission: 'auto' | 'manual';
  assists: AssistSettings;
  seed: number;
}

export const WEAR_OPTIONS = [
  { label: 'Aus', value: 0 },
  { label: 'Normal', value: 1 },
  { label: 'Hoch (×3)', value: 3 },
  { label: 'Extrem (×8)', value: 8 },
];
