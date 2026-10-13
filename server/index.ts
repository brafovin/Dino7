// Multiplayer-Server: Lobbys, Rennablauf (serverautoritativ für Runden, Positionen und Ergebnis),
// Validierung der Fahrzeugzustände und statische Auslieferung des gebauten Clients.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import { LapTracker } from '../src/shared/lapTracker';
import {
  type Ack,
  type CarStateMsg,
  CODE_ALPHABET,
  type CorrectionMsg,
  type GridEntry,
  type LobbyPlayer,
  type LobbySettings,
  type LobbyState,
  MAX_PLAYERS,
  MAX_SPEED,
  PROTOCOL_VERSION,
  type RaceEventMsg,
  type ResultEntry,
  sanitizeCode,
  sanitizeName,
  SNAPSHOT_HZ,
  type SnapshotMsg,
  type StandingEntry,
  validateDriver,
  validateSettings,
  validateState,
} from '../src/shared/protocol';
import { getDriver } from '../src/shared/teams';
import { type Projection, Track } from '../src/shared/track';
import { getTrackDef } from '../src/shared/trackDefs';

const PORT = Number(process.env.PORT ?? process.env.SERVER_PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST = [resolve(__dirname, '../dist'), resolve(process.cwd(), 'dist')].find((p) => existsSync(join(p, 'index.html')));

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- Statische Dateien
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (req.url?.startsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lobbies: lobbies.size, protocol: PROTOCOL_VERSION }));
    return;
  }
  if (!DIST) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('APEX GP Multiplayer-Server läuft. Client im Entwicklungsmodus über "npm run dev" (http://localhost:5173) öffnen oder vorher "npm run build" ausführen.');
    return;
  }
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const safe = normalize(urlPath).replace(/^([/\\])+/, '');
  let file = resolve(DIST, safe);
  if (!file.startsWith(DIST + sep) && file !== DIST) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const httpServer = createServer(serveStatic);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: false },
  pingInterval: 5000,
  pingTimeout: 8000,
  maxHttpBufferSize: 64 * 1024,
});

// ---------------------------------------------------------------- Strecken-Cache
const trackCache = new Map<string, Track>();
function getTrack(id: string): Track {
  let t = trackCache.get(id);
  if (!t) {
    t = new Track(getTrackDef(id));
    trackCache.set(id, t);
  }
  return t;
}

// ---------------------------------------------------------------- Lobby
interface PlayerConn {
  id: string;
  socket: Socket;
  name: string;
  driverId: string | null;
  ready: boolean;
  ping: number;
  connected: boolean;
  loaded: boolean;
  // Rennen
  state: CarStateMsg | null;
  lastAccept: number;
  lastSeq: number;
  proj: Projection;
  hint: number;
  lap: LapTracker | null;
  prevS: number;
  prevT: number;
  progress: number;
  finished: boolean;
  finishTime: number | null;
  finishOrder: number;
  dnf: boolean;
  history: Float64Array;
  histLen: number;
  slot: number;
  corrections: number;
  tokens: number;
  lastTokenRefill: number;
}

const HIST = 6000;

class Lobby {
  readonly code: string;
  hostId: string;
  status: LobbyState['status'] = 'waiting';
  settings: LobbySettings = { trackId: 'silverstone', laps: 3, weather: 'dry' };
  readonly players = new Map<string, PlayerConn>();
  raceId = '';
  private track: Track | null = null;
  private lightsOut = 0;
  private loadTimer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private chequeredAt: number | null = null;
  private finishCounter = 0;
  private grid: GridEntry[] = [];
  lastActivity = Date.now();

  constructor(code: string, hostId: string) {
    this.code = code;
    this.hostId = hostId;
  }

  get room(): string {
    return `lobby:${this.code}`;
  }

  view(): LobbyState {
    const players: LobbyPlayer[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      driverId: p.driverId,
      ready: p.ready,
      host: p.id === this.hostId,
      ping: p.ping,
      connected: p.connected,
    }));
    return { code: this.code, hostId: this.hostId, status: this.status, settings: this.settings, players };
  }

  broadcast(): void {
    io.to(this.room).emit('lobby:state', this.view());
  }

  add(socket: Socket, name: string): PlayerConn {
    const p: PlayerConn = {
      id: socket.id,
      socket,
      name,
      driverId: null,
      ready: false,
      ping: 0,
      connected: true,
      loaded: false,
      state: null,
      lastAccept: 0,
      lastSeq: -1,
      proj: { i: 0, s: 0, d: 0, y: 0, tx: 0, tz: 1, dist2: 0 },
      hint: -1,
      lap: null,
      prevS: 0,
      prevT: 0,
      progress: 0,
      finished: false,
      finishTime: null,
      finishOrder: 0,
      dnf: false,
      history: new Float64Array(HIST * 2),
      histLen: 0,
      slot: 0,
      corrections: 0,
      tokens: 120,
      lastTokenRefill: Date.now(),
    };
    // freien Fahrer vorschlagen
    this.players.set(p.id, p);
    socket.join(this.room);
    this.lastActivity = Date.now();
    return p;
  }

  remove(id: string, reason: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.socket.leave(this.room);
    if (this.status === 'racing' || this.status === 'countdown' || this.status === 'loading') {
      // Im Rennen: als getrennt markieren, damit das Ergebnis vollständig bleibt
      p.connected = false;
      if (!p.finished) p.dnf = true;
      io.to(this.room).emit('race:event', { type: 'left', id, name: p.name } satisfies RaceEventMsg);
      if ([...this.players.values()].every((x) => !x.connected)) {
        this.resetToLobby();
        this.players.clear();
      }
    } else {
      this.players.delete(id);
    }
    if (this.hostId === id) {
      const next = [...this.players.values()].find((x) => x.connected);
      if (next) this.hostId = next.id;
    }
    log(`Lobby ${this.code}: ${p.name} verlässt (${reason})`);
    this.broadcast();
    this.checkLoaded();
    this.checkRaceEnd();
  }

  isEmpty(): boolean {
    return ![...this.players.values()].some((p) => p.connected);
  }

  setDriver(p: PlayerConn, driverId: string): string | null {
    if (this.status !== 'waiting') return 'Fahrerwahl nur in der Lobby möglich';
    for (const o of this.players.values()) if (o !== p && o.driverId === driverId) return 'Fahrer bereits vergeben';
    p.driverId = driverId;
    this.broadcast();
    return null;
  }

  start(by: PlayerConn): string | null {
    if (by.id !== this.hostId) return 'Nur der Host kann starten';
    if (this.status !== 'waiting') return 'Rennen läuft bereits';
    const ps = [...this.players.values()].filter((p) => p.connected);
    if (ps.some((p) => !p.driverId)) return 'Alle Spieler müssen einen Fahrer wählen';
    if (ps.some((p) => p.id !== this.hostId && !p.ready)) return 'Nicht alle Spieler sind bereit';
    this.status = 'loading';
    this.raceId = `${this.code}-${Date.now().toString(36)}`;
    this.track = getTrack(this.settings.trackId);
    // Startaufstellung: zufällige Reihenfolge
    const shuffled = ps.slice().sort(() => Math.random() - 0.5);
    this.grid = shuffled.map((p, k) => ({ id: p.id, name: p.name, driverId: p.driverId as string, slot: k }));
    this.finishCounter = 0;
    this.chequeredAt = null;
    for (const p of this.players.values()) {
      const g = this.grid.find((x) => x.id === p.id);
      p.slot = g ? g.slot : 0;
      p.loaded = false;
      p.state = null;
      p.lastSeq = -1;
      p.hint = -1;
      p.lap = new LapTracker(this.track.length, this.track.sectors[0], this.track.sectors[1]);
      p.finished = false;
      p.finishTime = null;
      p.finishOrder = 0;
      p.dnf = !p.connected;
      p.histLen = 0;
      p.progress = 0;
      p.corrections = 0;
      const slot = this.track.gridSlot(p.slot);
      p.prevS = slot.s;
    }
    io.to(this.room).emit('race:load', { raceId: this.raceId, trackId: this.settings.trackId, laps: this.settings.laps, weather: this.settings.weather, grid: this.grid });
    this.broadcast();
    this.loadTimer = setTimeout(() => this.beginCountdown(), 20000);
    log(`Lobby ${this.code}: Rennen ${this.raceId} auf ${this.settings.trackId} (${this.grid.length} Spieler)`);
    return null;
  }

  markLoaded(p: PlayerConn, raceId: unknown): void {
    if (this.status !== 'loading' || raceId !== this.raceId) return;
    p.loaded = true;
    this.checkLoaded();
  }

  private checkLoaded(): void {
    if (this.status !== 'loading') return;
    const active = [...this.players.values()].filter((p) => p.connected);
    if (active.length && active.every((p) => p.loaded)) this.beginCountdown();
  }

  private beginCountdown(): void {
    if (this.status !== 'loading') return;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
    const now = Date.now();
    const lightsStart = now + 2000;
    this.lightsOut = lightsStart + 5000 + 500 + Math.floor(Math.random() * 2000);
    this.status = 'countdown';
    io.to(this.room).emit('race:countdown', { raceId: this.raceId, lightsStart, lightsOut: this.lightsOut });
    this.broadcast();
    this.tick = setInterval(() => this.update(), 1000 / SNAPSHOT_HZ);
  }

  private raceTime(now = Date.now()): number {
    return (now - this.lightsOut) / 1000;
  }

  private correct(p: PlayerConn, reason: string): void {
    const tr = this.track!;
    p.corrections++;
    let msg: CorrectionMsg;
    if (p.state) msg = { x: p.state.x, z: p.state.z, h: p.state.h, reason };
    else {
      const slot = tr.gridSlot(p.slot);
      const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
      tr.pointAt(slot.s, slot.d, pt);
      msg = { x: pt.x, z: pt.z, h: Math.atan2(pt.tx, pt.tz), reason };
    }
    p.socket.emit('race:correction', msg);
  }

  onState(p: PlayerConn, raw: unknown): void {
    if (this.status !== 'countdown' && this.status !== 'racing') return;
    if (p.finished && this.status !== 'racing') return;
    const st = validateState(raw);
    if (!st) return;
    if (st.seq <= p.lastSeq) return;
    const tr = this.track!;
    const now = Date.now();
    // Bewegungsplausibilität
    if (p.state) {
      const dt = Math.max(0.02, (now - p.lastAccept) / 1000);
      const dist = Math.hypot(st.x - p.state.x, st.z - p.state.z);
      if (dist > MAX_SPEED * dt + 8) {
        this.correct(p, 'Unplausible Bewegung');
        p.lastSeq = st.seq;
        return;
      }
    }
    tr.project(st.x, st.z, p.hint, p.proj, st.y);
    p.hint = p.proj.i;
    const bar = tr.barrierAt(p.proj.s, p.proj.d > 0);
    if (Math.abs(p.proj.d) > bar + 3 || p.proj.dist2 > 150 * 150) {
      this.correct(p, 'Außerhalb der Strecke');
      p.lastSeq = st.seq;
      return;
    }
    // Vor dem Start an der Startposition bleiben
    if (this.status === 'countdown' || now < this.lightsOut) {
      const slot = tr.gridSlot(p.slot);
      if (Math.abs(tr.deltaS(slot.s, p.proj.s)) > 4 || Math.abs(slot.d - p.proj.d) > 3) {
        p.state = null;
        this.correct(p, 'Frühstart');
        p.lastSeq = st.seq;
        return;
      }
    }
    p.lastSeq = st.seq;
    p.state = st;
    p.lastAccept = now;
    // Rundenwertung (serverseitig)
    if (this.status === 'racing' && p.lap && !p.finished && !p.dnf) {
      const t = this.raceTime(now);
      const evs = p.lap.update(p.prevS, p.proj.s, p.prevT, t);
      for (const e of evs) {
        if (e.type === 'lap') {
          io.to(this.room).emit('race:event', { type: 'lap', id: p.id, name: p.name, lapTime: e.lapTime, lap: e.lap } satisfies RaceEventMsg);
          if (!this.chequeredAt && p.lap.completed >= this.settings.laps) this.chequeredAt = now;
          if (this.chequeredAt) {
            p.finished = true;
            p.finishTime = e.time;
            p.finishOrder = ++this.finishCounter;
            io.to(this.room).emit('race:event', { type: 'finish', id: p.id, name: p.name, pos: p.finishOrder } satisfies RaceEventMsg);
          }
        }
      }
      p.prevS = p.proj.s;
      p.prevT = t;
      p.progress = p.lap.progress(p.proj.s);
      if (p.histLen < HIST) {
        p.history[p.histLen * 2] = p.progress;
        p.history[p.histLen * 2 + 1] = t;
        p.histLen++;
      }
    } else {
      p.prevS = p.proj.s;
      p.prevT = this.raceTime(now);
      if (p.lap) p.progress = p.lap.progress(p.proj.s);
    }
  }

  /** Zeitpunkt, zu dem Spieler o die Fortschrittsmarke prog erreichte. */
  private timeAt(o: PlayerConn, prog: number): number | null {
    const n = o.histLen;
    if (n < 2) return null;
    const H = o.history;
    if (prog < H[0] || prog > H[(n - 1) * 2]) return null;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (H[m * 2] <= prog) lo = m;
      else hi = m;
    }
    const p0 = H[lo * 2];
    const p1 = H[hi * 2];
    const f = p1 > p0 ? (prog - p0) / (p1 - p0) : 0;
    return H[lo * 2 + 1] + (H[hi * 2 + 1] - H[lo * 2 + 1]) * f;
  }

  private standings(): StandingEntry[] {
    const L = this.track!.length;
    const ps = [...this.players.values()].filter((p) => this.grid.some((g) => g.id === p.id));
    ps.sort((a, b) => {
      if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
      return b.progress - a.progress;
    });
    return ps.map((p, i) => {
      let gap: number | null = null;
      if (i > 0) {
        const a = ps[i - 1];
        if (p.finished && a.finished && p.finishTime !== null && a.finishTime !== null) gap = p.finishTime - a.finishTime;
        else if (a.progress - p.progress > L) gap = -Math.floor((a.progress - p.progress) / L);
        else {
          const tMe = this.timeAt(p, p.progress);
          const tA = this.timeAt(a, p.progress);
          gap = tMe !== null && tA !== null ? Math.max(0, tMe - tA) : null;
        }
      }
      return {
        id: p.id,
        pos: i + 1,
        lap: p.lap ? Math.min(this.settings.laps, p.lap.completed + 1) : 1,
        gap,
        finished: p.finished,
        dnf: p.dnf,
        best: p.lap?.bestLap ?? null,
        last: p.lap?.lastLap ?? null,
      };
    });
  }

  private update(): void {
    const now = Date.now();
    if (this.status === 'countdown' && now >= this.lightsOut) {
      this.status = 'racing';
      for (const p of this.players.values()) {
        p.lap?.startRace(0);
        p.prevT = 0;
      }
      this.broadcast();
    }
    if (this.status !== 'countdown' && this.status !== 'racing') return;
    const cars = [...this.players.values()]
      .filter((p) => p.state && p.connected)
      .map((p) => {
        const s = p.state as CarStateMsg;
        return { id: p.id, x: s.x, y: s.y, z: s.z, h: s.h, vx: s.vx, vy: s.vy, yr: s.yr, st: s.st, rpm: s.rpm, g: s.g, th: s.th, br: s.br, cmp: s.cmp, pit: s.pit };
      });
    const snap: SnapshotMsg = { t: now, cars, standings: this.standings() };
    io.to(this.room).volatile.emit('snapshot', snap);
    // Inaktive Spieler (keine Daten seit 10 s) als DNF werten
    for (const p of this.players.values()) {
      if (this.status === 'racing' && p.connected && !p.finished && !p.dnf && p.lastAccept && now - p.lastAccept > 10000) {
        p.dnf = true;
        io.to(this.room).emit('race:event', { type: 'dnf', id: p.id, name: p.name } satisfies RaceEventMsg);
      }
    }
    this.checkRaceEnd();
  }

  private checkRaceEnd(): void {
    if (this.status !== 'racing') return;
    const active = [...this.players.values()].filter((p) => this.grid.some((g) => g.id === p.id));
    const allDone = active.every((p) => p.finished || p.dnf || !p.connected);
    const timeout = this.chequeredAt !== null && Date.now() - this.chequeredAt > 60000;
    if (!allDone && !timeout) return;
    this.status = 'finished';
    const st = this.standings();
    const rows: ResultEntry[] = st.map((e) => {
      const p = this.players.get(e.id)!;
      return {
        pos: e.pos,
        id: e.id,
        name: p.name,
        driverId: p.driverId ?? 'leclerc',
        laps: p.lap ? p.lap.completed : 0,
        time: p.finished ? p.finishTime : null,
        best: p.lap?.bestLap ?? null,
        status: !p.connected ? 'Getrennt' : p.finished ? 'Im Ziel' : 'DNF',
      };
    });
    io.to(this.room).emit('race:results', { raceId: this.raceId, rows });
    log(`Lobby ${this.code}: Rennen beendet, Sieger ${rows[0]?.name ?? '-'}`);
    setTimeout(() => this.resetToLobby(), 1500);
  }

  resetToLobby(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.tick = null;
    this.loadTimer = null;
    this.status = 'waiting';
    for (const [id, p] of this.players) {
      if (!p.connected) this.players.delete(id);
      else {
        p.ready = false;
        p.state = null;
      }
    }
    if (!this.players.has(this.hostId)) {
      const next = [...this.players.values()][0];
      if (next) this.hostId = next.id;
    }
    this.broadcast();
  }

  dispose(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.loadTimer) clearTimeout(this.loadTimer);
  }
}

const lobbies = new Map<string, Lobby>();
const socketLobby = new Map<string, Lobby>();

function newCode(): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!lobbies.has(c)) return c;
  }
}

function leave(socket: Socket, reason: string): void {
  const lobby = socketLobby.get(socket.id);
  if (!lobby) return;
  socketLobby.delete(socket.id);
  lobby.remove(socket.id, reason);
  if (lobby.isEmpty()) {
    lobby.dispose();
    lobbies.delete(lobby.code);
    log(`Lobby ${lobby.code} geschlossen`);
  }
}

function rateOk(p: PlayerConn | undefined): boolean {
  if (!p) return true;
  const now = Date.now();
  p.tokens = Math.min(120, p.tokens + ((now - p.lastTokenRefill) / 1000) * 60);
  p.lastTokenRefill = now;
  if (p.tokens < 1) return false;
  p.tokens -= 1;
  return true;
}

type AckFn = (a: Ack) => void;
const safeAck = (fn: unknown): AckFn => (typeof fn === 'function' ? (fn as AckFn) : () => undefined);

io.on('connection', (socket) => {
  const v = Number(socket.handshake.auth?.protocol);
  if (v && v !== PROTOCOL_VERSION) {
    socket.emit('server:error', { message: 'Inkompatible Client-Version' });
    socket.disconnect(true);
    return;
  }
  const me = () => socketLobby.get(socket.id)?.players.get(socket.id);

  socket.on('time:ping', (t: unknown, ack: unknown) => {
    safeAck(ack)({ ok: true, data: { t: typeof t === 'number' ? t : 0, server: Date.now() } });
  });

  socket.on('lobby:create', (payload: unknown, ack: unknown) => {
    const reply = safeAck(ack);
    const name = sanitizeName((payload as { name?: unknown })?.name);
    if (!name) return reply({ ok: false, error: 'Ungültiger Name' });
    leave(socket, 'neue Lobby');
    const code = newCode();
    const lobby = new Lobby(code, socket.id);
    lobbies.set(code, lobby);
    socketLobby.set(socket.id, lobby);
    lobby.add(socket, name);
    log(`Lobby ${code} erstellt von ${name}`);
    lobby.broadcast();
    reply({ ok: true, data: { code, id: socket.id } });
  });

  socket.on('lobby:join', (payload: unknown, ack: unknown) => {
    const reply = safeAck(ack);
    const o = (payload ?? {}) as { name?: unknown; code?: unknown };
    const name = sanitizeName(o.name);
    const code = sanitizeCode(o.code);
    if (!name) return reply({ ok: false, error: 'Ungültiger Name' });
    if (!code) return reply({ ok: false, error: 'Ungültiger Lobby-Code' });
    const lobby = lobbies.get(code);
    if (!lobby) return reply({ ok: false, error: 'Lobby nicht gefunden' });
    if (lobby.status !== 'waiting') return reply({ ok: false, error: 'Rennen läuft bereits' });
    if ([...lobby.players.values()].filter((p) => p.connected).length >= MAX_PLAYERS) return reply({ ok: false, error: 'Lobby ist voll' });
    leave(socket, 'Lobbywechsel');
    socketLobby.set(socket.id, lobby);
    lobby.add(socket, name);
    log(`Lobby ${code}: ${name} tritt bei`);
    lobby.broadcast();
    reply({ ok: true, data: { code, id: socket.id } });
  });

  socket.on('lobby:leave', () => leave(socket, 'verlassen'));

  socket.on('lobby:driver', (driverId: unknown, ack: unknown) => {
    const reply = safeAck(ack);
    const lobby = socketLobby.get(socket.id);
    const p = me();
    const d = validateDriver(driverId);
    if (!lobby || !p || !d) return reply({ ok: false, error: 'Ungültige Auswahl' });
    const err = lobby.setDriver(p, d);
    reply(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on('lobby:ready', (ready: unknown) => {
    const lobby = socketLobby.get(socket.id);
    const p = me();
    if (!lobby || !p || lobby.status !== 'waiting') return;
    p.ready = ready === true && !!p.driverId;
    lobby.broadcast();
  });

  socket.on('lobby:settings', (s: unknown, ack: unknown) => {
    const reply = safeAck(ack);
    const lobby = socketLobby.get(socket.id);
    const settings = validateSettings(s);
    if (!lobby || lobby.hostId !== socket.id) return reply({ ok: false, error: 'Nur der Host darf Einstellungen ändern' });
    if (!settings) return reply({ ok: false, error: 'Ungültige Einstellungen' });
    if (lobby.status !== 'waiting') return reply({ ok: false, error: 'Nicht während des Rennens' });
    lobby.settings = settings;
    for (const p of lobby.players.values()) if (p.id !== lobby.hostId) p.ready = false;
    lobby.broadcast();
    reply({ ok: true });
  });

  socket.on('lobby:ping', (ping: unknown) => {
    const lobby = socketLobby.get(socket.id);
    const p = me();
    if (!lobby || !p || typeof ping !== 'number' || !Number.isFinite(ping)) return;
    p.ping = Math.max(0, Math.min(5000, Math.round(ping)));
  });

  socket.on('lobby:start', (_: unknown, ack: unknown) => {
    const reply = safeAck(ack);
    const lobby = socketLobby.get(socket.id);
    const p = me();
    if (!lobby || !p) return reply({ ok: false, error: 'Keine Lobby' });
    const err = lobby.start(p);
    reply(err ? { ok: false, error: err } : { ok: true });
  });

  socket.on('race:loaded', (raceId: unknown) => {
    const lobby = socketLobby.get(socket.id);
    const p = me();
    if (lobby && p) lobby.markLoaded(p, raceId);
  });

  socket.on('state', (st: unknown) => {
    const lobby = socketLobby.get(socket.id);
    const p = me();
    if (!lobby || !p || !rateOk(p)) return;
    lobby.onState(p, st);
  });

  socket.on('disconnect', (reason) => leave(socket, `Verbindung getrennt: ${reason}`));
});

// Verwaiste Lobbys aufräumen
setInterval(() => {
  for (const [code, l] of lobbies) {
    if (l.isEmpty()) {
      l.dispose();
      lobbies.delete(code);
    }
  }
}, 30000).unref();

httpServer.listen(PORT, HOST, () => {
  log(`APEX GP Server auf http://localhost:${PORT} ${DIST ? `(Client aus ${DIST})` : '(nur Multiplayer – Client über Vite)'}`);
});

// Für Tests: sauberes Beenden
const shutdown = () => {
  for (const l of lobbies.values()) l.dispose();
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
void getDriver;
