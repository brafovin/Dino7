// Teams, Fahrer und Fahrzeug-Leistungswerte.
// Alle Lackierungen, Helme und Startnummern sind eigenständige, stilisierte Designs in den
// jeweiligen Teamfarben – keine offiziellen Logos oder Assets.

export interface TeamPerformance {
  /** Motorleistung (Multiplikator) */
  power: number;
  /** Abtrieb (Multiplikator auf ClA) */
  downforce: number;
  /** Luftwiderstand (Multiplikator auf CdA, kleiner = besser) */
  drag: number;
  /** Reifenverschleiß (kleiner = schonender) */
  tyreWear: number;
}

export type LiveryPattern = 'stripe' | 'split' | 'arrow' | 'fade' | 'band';

export interface TeamLivery {
  primary: string;
  secondary: string;
  accent: string;
  carbon: string;
  pattern: LiveryPattern;
}

export interface DriverSkill {
  /** Grundtempo 0..1 */
  pace: number;
  /** Zweikampfstärke / Überholbereitschaft 0..1 */
  racecraft: number;
  /** Konstanz 0..1 */
  consistency: number;
  /** Nässe-Können 0..1 */
  wet: number;
}

export interface Driver {
  id: string;
  name: string;
  code: string;
  number: number;
  nation: string;
  teamId: string;
  helmet: [string, string, string];
  skill: DriverSkill;
}

export interface Team {
  id: string;
  name: string;
  short: string;
  livery: TeamLivery;
  perf: TeamPerformance;
  drivers: Driver[];
}

type DriverInit = Omit<Driver, 'teamId'>;

function team(t: Omit<Team, 'drivers'>, drivers: DriverInit[]): Team {
  return { ...t, drivers: drivers.map((d) => ({ ...d, teamId: t.id })) };
}

const sk = (pace: number, racecraft: number, consistency: number, wet: number): DriverSkill => ({
  pace,
  racecraft,
  consistency,
  wet,
});

export const TEAMS: Team[] = [
  team(
    {
      id: 'ferrari',
      name: 'Ferrari',
      short: 'FER',
      livery: { primary: '#d40000', secondary: '#f4f4f4', accent: '#ffd800', carbon: '#1a1a1a', pattern: 'band' },
      perf: { power: 1.01, downforce: 1.01, drag: 1.0, tyreWear: 1.0 },
    },
    [
      { id: 'leclerc', name: 'Charles Leclerc', code: 'LEC', number: 16, nation: 'MON', helmet: ['#d40000', '#ffffff', '#1e3c8c'], skill: sk(0.99, 0.86, 0.88, 0.85) },
      { id: 'hamilton', name: 'Lewis Hamilton', code: 'HAM', number: 44, nation: 'GBR', helmet: ['#ffd400', '#7a1fa2', '#ffffff'], skill: sk(0.985, 0.93, 0.92, 0.96) },
    ],
  ),
  team(
    {
      id: 'mclaren',
      name: 'McLaren',
      short: 'MCL',
      livery: { primary: '#ff8000', secondary: '#1d1d24', accent: '#47c7fc', carbon: '#141418', pattern: 'split' },
      perf: { power: 1.0, downforce: 1.02, drag: 1.0, tyreWear: 0.97 },
    },
    [
      { id: 'norris', name: 'Lando Norris', code: 'NOR', number: 1, nation: 'GBR', helmet: ['#d6ff00', '#14b4ff', '#1a1a1a'], skill: sk(0.995, 0.87, 0.9, 0.9) },
      { id: 'piastri', name: 'Oscar Piastri', code: 'PIA', number: 81, nation: 'AUS', helmet: ['#0a2a6b', '#ffffff', '#ff8000'], skill: sk(0.99, 0.88, 0.93, 0.84) },
    ],
  ),
  team(
    {
      id: 'mercedes',
      name: 'Mercedes',
      short: 'MER',
      livery: { primary: '#c6ccd2', secondary: '#101214', accent: '#00d7b6', carbon: '#0c0d0f', pattern: 'fade' },
      perf: { power: 1.015, downforce: 1.0, drag: 0.99, tyreWear: 1.0 },
    },
    [
      { id: 'russell', name: 'George Russell', code: 'RUS', number: 63, nation: 'GBR', helmet: ['#1a2a6c', '#ffffff', '#00d7b6'], skill: sk(0.985, 0.88, 0.91, 0.88) },
      { id: 'antonelli', name: 'Andrea Kimi Antonelli', code: 'ANT', number: 12, nation: 'ITA', helmet: ['#00b0f0', '#ffffff', '#00d7b6'], skill: sk(0.975, 0.84, 0.82, 0.86) },
    ],
  ),
  team(
    {
      id: 'redbull',
      name: 'Red Bull Racing',
      short: 'RBR',
      livery: { primary: '#1b2a5c', secondary: '#e3132a', accent: '#ffc906', carbon: '#121624', pattern: 'arrow' },
      perf: { power: 1.0, downforce: 1.015, drag: 0.985, tyreWear: 1.0 },
    },
    [
      { id: 'verstappen', name: 'Max Verstappen', code: 'VER', number: 3, nation: 'NED', helmet: ['#ff6a00', '#1b2a5c', '#ffffff'], skill: sk(1.0, 0.97, 0.95, 0.97) },
      { id: 'hadjar', name: 'Isack Hadjar', code: 'HAD', number: 6, nation: 'FRA', helmet: ['#ffffff', '#1d5bd6', '#e3132a'], skill: sk(0.97, 0.84, 0.83, 0.82) },
    ],
  ),
  team(
    {
      id: 'astonmartin',
      name: 'Aston Martin',
      short: 'AMR',
      livery: { primary: '#00594f', secondary: '#cedc00', accent: '#ffffff', carbon: '#0b1513', pattern: 'stripe' },
      perf: { power: 1.005, downforce: 0.99, drag: 1.005, tyreWear: 1.02 },
    },
    [
      { id: 'alonso', name: 'Fernando Alonso', code: 'ALO', number: 14, nation: 'ESP', helmet: ['#1e4fa8', '#ffd200', '#e60000'], skill: sk(0.98, 0.96, 0.93, 0.93) },
      { id: 'stroll', name: 'Lance Stroll', code: 'STR', number: 18, nation: 'CAN', helmet: ['#ffffff', '#d40000', '#111111'], skill: sk(0.955, 0.8, 0.8, 0.86) },
    ],
  ),
  team(
    {
      id: 'cadillac',
      name: 'Cadillac',
      short: 'CAD',
      livery: { primary: '#111111', secondary: '#f2f2f2', accent: '#b9a46a', carbon: '#0a0a0a', pattern: 'split' },
      perf: { power: 1.01, downforce: 0.975, drag: 1.01, tyreWear: 1.02 },
    },
    [
      { id: 'bottas', name: 'Valtteri Bottas', code: 'BOT', number: 77, nation: 'FIN', helmet: ['#1d5cff', '#ffffff', '#00b3e6'], skill: sk(0.96, 0.82, 0.9, 0.84) },
      { id: 'perez', name: 'Sergio Pérez', code: 'PER', number: 11, nation: 'MEX', helmet: ['#006847', '#ffffff', '#ce1126'], skill: sk(0.965, 0.9, 0.84, 0.86) },
    ],
  ),
  team(
    {
      id: 'haas',
      name: 'Haas',
      short: 'HAA',
      livery: { primary: '#eef0f2', secondary: '#1a1a1e', accent: '#e10a1e', carbon: '#141414', pattern: 'stripe' },
      perf: { power: 1.01, downforce: 0.985, drag: 1.0, tyreWear: 1.03 },
    },
    [
      { id: 'bearman', name: 'Oliver Bearman', code: 'BEA', number: 87, nation: 'GBR', helmet: ['#141414', '#e10a1e', '#ffffff'], skill: sk(0.965, 0.84, 0.82, 0.83) },
      { id: 'ocon', name: 'Esteban Ocon', code: 'OCO', number: 31, nation: 'FRA', helmet: ['#ff4fa3', '#1e2a78', '#ffffff'], skill: sk(0.965, 0.87, 0.87, 0.88) },
    ],
  ),
  team(
    {
      id: 'racingbulls',
      name: 'Racing Bulls',
      short: 'RCB',
      livery: { primary: '#f4f6fb', secondary: '#1634cb', accent: '#e3132a', carbon: '#14161f', pattern: 'fade' },
      perf: { power: 1.0, downforce: 0.99, drag: 1.0, tyreWear: 1.0 },
    },
    [
      { id: 'lawson', name: 'Liam Lawson', code: 'LAW', number: 30, nation: 'NZL', helmet: ['#111111', '#c3002f', '#ffffff'], skill: sk(0.96, 0.88, 0.82, 0.84) },
      { id: 'lindblad', name: 'Arvid Lindblad', code: 'LIN', number: 41, nation: 'GBR', helmet: ['#ffcc00', '#0a3d91', '#ffffff'], skill: sk(0.955, 0.82, 0.8, 0.8) },
    ],
  ),
  team(
    {
      id: 'williams',
      name: 'Williams',
      short: 'WIL',
      livery: { primary: '#0a2a5e', secondary: '#00a3e0', accent: '#ffffff', carbon: '#0b1324', pattern: 'arrow' },
      perf: { power: 1.015, downforce: 0.98, drag: 0.985, tyreWear: 1.02 },
    },
    [
      { id: 'albon', name: 'Alexander Albon', code: 'ALB', number: 23, nation: 'THA', helmet: ['#0050c8', '#ffffff', '#ff2d55'], skill: sk(0.975, 0.86, 0.89, 0.87) },
      { id: 'sainz', name: 'Carlos Sainz', code: 'SAI', number: 55, nation: 'ESP', helmet: ['#ffd100', '#e2001a', '#1a1a1a'], skill: sk(0.98, 0.9, 0.9, 0.87) },
    ],
  ),
  team(
    {
      id: 'audi',
      name: 'Audi',
      short: 'AUD',
      livery: { primary: '#b7bcc1', secondary: '#121212', accent: '#e8003d', carbon: '#0d0d0d', pattern: 'band' },
      perf: { power: 0.995, downforce: 0.985, drag: 1.005, tyreWear: 1.0 },
    },
    [
      { id: 'hulkenberg', name: 'Nico Hülkenberg', code: 'HUL', number: 27, nation: 'GER', helmet: ['#ffffff', '#ffd700', '#1a1a1a'], skill: sk(0.965, 0.85, 0.9, 0.88) },
      { id: 'bortoleto', name: 'Gabriel Bortoleto', code: 'BOR', number: 5, nation: 'BRA', helmet: ['#00953a', '#ffdf00', '#002776'], skill: sk(0.96, 0.82, 0.83, 0.82) },
    ],
  ),
  team(
    {
      id: 'alpine',
      name: 'Alpine',
      short: 'ALP',
      livery: { primary: '#0a6fd8', secondary: '#ff7ab8', accent: '#ffffff', carbon: '#0d1626', pattern: 'split' },
      perf: { power: 1.015, downforce: 0.98, drag: 1.0, tyreWear: 1.01 },
    },
    [
      { id: 'gasly', name: 'Pierre Gasly', code: 'GAS', number: 10, nation: 'FRA', helmet: ['#0b1e5b', '#ffffff', '#ff2a68'], skill: sk(0.97, 0.86, 0.87, 0.88) },
      { id: 'colapinto', name: 'Franco Colapinto', code: 'COL', number: 43, nation: 'ARG', helmet: ['#74acdf', '#ffffff', '#f6b40e'], skill: sk(0.955, 0.83, 0.8, 0.82) },
    ],
  ),
];

export const ALL_DRIVERS: Driver[] = TEAMS.flatMap((t) => t.drivers);

export function getTeam(id: string): Team {
  const t = TEAMS.find((x) => x.id === id);
  if (!t) throw new Error(`Unbekanntes Team: ${id}`);
  return t;
}

export function getDriver(id: string): Driver {
  const d = ALL_DRIVERS.find((x) => x.id === id);
  if (!d) throw new Error(`Unbekannter Fahrer: ${id}`);
  return d;
}

export function isDriverId(id: unknown): id is string {
  return typeof id === 'string' && ALL_DRIVERS.some((d) => d.id === id);
}
