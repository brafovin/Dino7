// Netzwerkprotokoll (Socket.IO) zwischen Client und Server inkl. Validierungshilfen.
import type { Compound, Weather } from './carPhysics';
import { isDriverId } from './teams';
import { isTrackId } from './trackDefs';

export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 12;
export const STATE_HZ = 20;
export const SNAPSHOT_HZ = 20;
export const MAX_LAPS = 30;
/** Plausibilitätsgrenze für Geschwindigkeiten (m/s) */
export const MAX_SPEED = 115;

export type LobbyStatus = 'waiting' | 'loading' | 'countdown' | 'racing' | 'finished';

export interface LobbyPlayer {
  id: string;
  name: string;
  driverId: string | null;
  ready: boolean;
  host: boolean;
  ping: number;
  connected: boolean;
}

export interface LobbySettings {
  trackId: string;
  laps: number;
  weather: Weather;
}

export interface LobbyState {
  code: string;
  hostId: string;
  status: LobbyStatus;
  settings: LobbySettings;
  players: LobbyPlayer[];
}

export interface GridEntry {
  id: string;
  name: string;
  driverId: string;
  slot: number;
}

export interface RaceLoadMsg {
  raceId: string;
  trackId: string;
  laps: number;
  weather: Weather;
  grid: GridEntry[];
}

export interface CountdownMsg {
  raceId: string;
  /** Serverzeit (ms), zu der die erste Ampel leuchtet */
  lightsStart: number;
  /** Serverzeit (ms) des Startsignals */
  lightsOut: number;
}

/** Fahrzeugzustand, den ein Client 20× pro Sekunde sendet. */
export interface CarStateMsg {
  seq: number;
  x: number;
  y: number;
  z: number;
  h: number;
  vx: number;
  vy: number;
  yr: number;
  st: number;
  rpm: number;
  g: number;
  th: number;
  br: number;
  cmp: Compound;
  pit: boolean;
}

export interface SnapshotCar {
  id: string;
  x: number;
  y: number;
  z: number;
  h: number;
  vx: number;
  vy: number;
  yr: number;
  st: number;
  rpm: number;
  g: number;
  th: number;
  br: number;
  cmp: Compound;
  pit: boolean;
}

export interface StandingEntry {
  id: string;
  pos: number;
  lap: number;
  /** Abstand zum Vordermann in s, oder negative Zahl = Runden zurück */
  gap: number | null;
  finished: boolean;
  dnf: boolean;
  best: number | null;
  last: number | null;
}

export interface SnapshotMsg {
  t: number;
  cars: SnapshotCar[];
  standings: StandingEntry[];
}

export interface ResultEntry {
  pos: number;
  id: string;
  name: string;
  driverId: string;
  laps: number;
  time: number | null;
  best: number | null;
  status: 'Im Ziel' | 'DNF' | 'Getrennt';
}

export interface ResultsMsg {
  raceId: string;
  rows: ResultEntry[];
}

export interface CorrectionMsg {
  x: number;
  z: number;
  h: number;
  reason: string;
}

export interface RaceEventMsg {
  type: 'lap' | 'finish' | 'left' | 'dnf';
  id: string;
  name: string;
  lapTime?: number;
  lap?: number;
  pos?: number;
}

export interface Ack<T = unknown> {
  ok: boolean;
  error?: string;
  data?: T;
}

// ---------------------------------------------------------------- Validierung

const isNum = (v: unknown, lo = -1e7, hi = 1e7): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const COMPOUND_SET = new Set(['soft', 'medium', 'hard', 'inter', 'wet']);

export function sanitizeName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 16);
  return s.length >= 1 ? s : null;
}

export function sanitizeCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 5 ? s : null;
}

export function validateSettings(v: unknown): LobbySettings | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isTrackId(o.trackId)) return null;
  if (!isNum(o.laps, 1, MAX_LAPS) || !Number.isInteger(o.laps)) return null;
  if (o.weather !== 'dry' && o.weather !== 'wet') return null;
  return { trackId: o.trackId, laps: o.laps, weather: o.weather };
}

export function validateDriver(v: unknown): string | null {
  return isDriverId(v) ? v : null;
}

export function validateState(v: unknown): CarStateMsg | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isNum(o.seq, 0, 1e9) || !isNum(o.x) || !isNum(o.y, -500, 2000) || !isNum(o.z) || !isNum(o.h, -1e5, 1e5)) return null;
  if (!isNum(o.vx, -MAX_SPEED, MAX_SPEED) || !isNum(o.vy, -60, 60) || !isNum(o.yr, -30, 30) || !isNum(o.st, -1, 1)) return null;
  if (!isNum(o.rpm, 0, 20000) || !isNum(o.g, -1, 8) || !isNum(o.th, 0, 1) || !isNum(o.br, 0, 1)) return null;
  if (typeof o.cmp !== 'string' || !COMPOUND_SET.has(o.cmp)) return null;
  return {
    seq: o.seq,
    x: o.x,
    y: o.y,
    z: o.z,
    h: o.h,
    vx: o.vx,
    vy: o.vy,
    yr: o.yr,
    st: o.st,
    rpm: o.rpm,
    g: Math.round(o.g),
    th: o.th,
    br: o.br,
    cmp: o.cmp as Compound,
    pit: o.pit === true,
  };
}

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
