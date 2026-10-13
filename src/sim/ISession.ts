// Gemeinsame Schnittstelle für Einzelspieler- (RaceSession) und Mehrspieler-Sitzungen (NetRaceSession).
import type { CarInput } from '../shared/carPhysics';
import type { RaceLineData, SpeedProfile } from '../shared/racingLine';
import type { Track } from '../shared/track';
import type { SessionConfig } from './config';
import type { Phase, ResultRow, SessionCar, SessionEvent, SessionKind } from './RaceSession';

export interface ISession {
  readonly kind: SessionKind | 'multiplayer';
  readonly cfg: SessionConfig;
  readonly track: Track;
  readonly line: RaceLineData;
  readonly cars: SessionCar[];
  readonly player: SessionCar;
  playerProfile: SpeedProfile;
  phase: Phase;
  time: number;
  goTime: number;
  lights: number;
  readonly totalLaps: number;
  bestLapOverall: { carId: number; time: number } | null;
  readonly openEnded: boolean;
  /** Fahrzeuge werden lokal im festen Takt simuliert (Render-Interpolation nötig) */
  readonly localSim: boolean;
  playerFinishedAt: number | null;
  step(dt: number, input: CarInput): void;
  drainEvents(): SessionEvent[];
  results(): ResultRow[];
  startCountdown(): void;
  resetCar(c: SessionCar, back?: number): void;
  forceFinish(): void;
  qualiResults: ResultRow[] | null;
}
