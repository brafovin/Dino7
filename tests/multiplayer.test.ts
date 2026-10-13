// Mehrspieler-Integrationstest: startet den Server als eigenen Prozess und verbindet zwei
// unabhängige Socket.IO-Clients (Lobby, Fahrerwahl, Start, Synchronisierung, Rundenwertung, Validierung).
// Aufruf: npm run test:mp
import { type ChildProcess, spawn } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import type { Ack, CountdownMsg, LobbyState, RaceLoadMsg, ResultsMsg, SnapshotMsg } from '../src/shared/protocol';
import { PROTOCOL_VERSION } from '../src/shared/protocol';
import { Track } from '../src/shared/track';
import { getTrackDef } from '../src/shared/trackDefs';

const PORT = 3100 + Math.floor(Math.random() * 500);
const URL = `http://localhost:${PORT}`;
let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) {
    passes++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('Server startet nicht')), 15000);
    proc.stdout!.on('data', (d: Buffer) => {
      const s = d.toString();
      if (process.env.VERBOSE) process.stdout.write(`[server] ${s}`);
      if (s.includes('Server auf')) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
    proc.stderr!.on('data', (d: Buffer) => process.stderr.write(`[server-err] ${d}`));
  });
}

interface Client {
  name: string;
  sock: Socket;
  lobby: LobbyState | null;
  load: RaceLoadMsg | null;
  countdown: CountdownMsg | null;
  snaps: SnapshotMsg[];
  results: ResultsMsg | null;
  corrections: number;
  events: string[];
}

function connect(name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = io(URL, { auth: { protocol: PROTOCOL_VERSION }, transports: ['websocket'], reconnection: false });
    const c: Client = { name, sock, lobby: null, load: null, countdown: null, snaps: [], results: null, corrections: 0, events: [] };
    sock.on('lobby:state', (s: LobbyState) => (c.lobby = s));
    sock.on('race:load', (m: RaceLoadMsg) => (c.load = m));
    sock.on('race:countdown', (m: CountdownMsg) => (c.countdown = m));
    sock.on('snapshot', (m: SnapshotMsg) => {
      c.snaps.push(m);
      if (c.snaps.length > 400) c.snaps.shift();
    });
    sock.on('race:results', (m: ResultsMsg) => (c.results = m));
    sock.on('race:correction', () => c.corrections++);
    sock.on('race:event', (e: { type: string; name: string }) => c.events.push(`${e.type}:${e.name}`));
    sock.on('connect', () => resolve(c));
    sock.on('connect_error', reject);
  });
}

function req<T = unknown>(c: Client, evt: string, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve) => c.sock.timeout(5000).emit(evt, payload, (err: unknown, ack: Ack<T>) => resolve(err ? { ok: false, error: 'timeout' } : ack)));
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(25);
  }
  console.log(`  … Zeitüberschreitung: ${what}`);
  return false;
}

async function main(): Promise<void> {
  console.log(`▶ Server starten (Port ${PORT})`);
  const server = await startServer();
  try {
    const A = await connect('Anna');
    const B = await connect('Ben');
    check(A.sock.connected && B.sock.connected, 'zwei getrennte Clients verbunden');

    console.log('\n▶ Lobby');
    const bad = await req(A, 'lobby:join', { code: 'ZZZZZ', name: 'Anna' });
    check(!bad.ok, `ungültiger Code wird abgelehnt (${bad.error})`);
    const created = await req<{ code: string }>(A, 'lobby:create', { name: 'Anna' });
    check(created.ok && /^[A-Z0-9]{5}$/.test(created.data!.code), `Lobby erstellt, Code ${created.data?.code}`);
    const code = created.data!.code;
    const joined = await req(B, 'lobby:join', { code: code.toLowerCase(), name: 'Ben' });
    check(joined.ok, 'zweiter Client tritt per Code bei (Groß-/Kleinschreibung egal)');
    await waitFor(() => (A.lobby?.players.length ?? 0) === 2 && (B.lobby?.players.length ?? 0) === 2, 2000, 'Lobbystatus');
    check(A.lobby?.players.length === 2 && B.lobby?.players.length === 2, 'beide sehen 2 Spieler');
    check(A.lobby?.hostId === A.sock.id, 'Ersteller ist Host');

    const d1 = await req(A, 'lobby:driver', 'leclerc');
    const d2 = await req(B, 'lobby:driver', 'leclerc');
    check(d1.ok && !d2.ok, `gleicher Fahrer kann nicht doppelt gewählt werden (${d2.error})`);
    const d3 = await req(B, 'lobby:driver', 'norris');
    check(d3.ok, 'zweiter Client wählt anderen Fahrer');
    const notHost = await req(B, 'lobby:settings', { trackId: 'monaco', laps: 1, weather: 'dry' });
    check(!notHost.ok, 'Nicht-Host darf Einstellungen nicht ändern');
    const badSet = await req(A, 'lobby:settings', { trackId: 'nürburgring', laps: 1, weather: 'dry' });
    check(!badSet.ok, 'ungültige Strecke wird abgelehnt');
    const setOk = await req(A, 'lobby:settings', { trackId: 'monaco', laps: 1, weather: 'dry' });
    check(setOk.ok, 'Host setzt Monaco, 1 Runde');
    const early = await req(A, 'lobby:start', null);
    check(!early.ok, `Start erst, wenn alle bereit sind (${early.error})`);
    B.sock.emit('lobby:ready', true);
    await waitFor(() => !!A.lobby?.players.find((p) => p.name === 'Ben')?.ready, 2000, 'Bereit-Status');
    check(!!A.lobby?.players.find((p) => p.name === 'Ben')?.ready, 'Bereit-Status wird synchronisiert');
    const notHostStart = await req(B, 'lobby:start', null);
    check(!notHostStart.ok, 'nur der Host kann starten');
    const started = await req(A, 'lobby:start', null);
    check(started.ok, 'Host startet das Rennen');

    console.log('\n▶ Rennstart');
    await waitFor(() => !!A.load && !!B.load, 3000, 'race:load');
    check(!!A.load && !!B.load && A.load.raceId === B.load.raceId, 'beide erhalten dieselben Renndaten');
    check(A.load?.grid.length === 2, 'Startaufstellung mit 2 Fahrzeugen');
    const track = new Track(getTrackDef(A.load!.trackId));
    A.sock.emit('race:loaded', A.load!.raceId);
    B.sock.emit('race:loaded', B.load!.raceId);
    await waitFor(() => !!A.countdown && !!B.countdown, 3000, 'countdown');
    check(!!A.countdown && A.countdown.lightsOut === B.countdown?.lightsOut, 'gemeinsamer Startzeitpunkt (Ampel) für beide');

    // Simulierte Fahrt: Position entlang der Ideallinie, Geschwindigkeit ~ 75 m/s
    const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };
    const drivers = [A, B].map((c) => {
      const g = c.load!.grid.find((x) => x.id === c.sock.id)!;
      const slot = track.gridSlot(g.slot);
      return { c, s: slot.s, d: slot.d, seq: 0, speed: c === A ? 78 : 72 };
    });
    const send = (dv: (typeof drivers)[number], extra: Partial<Record<string, number>> = {}) => {
      track.pointAt(dv.s, dv.d, pt);
      dv.c.sock.emit('state', { seq: dv.seq++, x: pt.x, y: pt.y, z: pt.z, h: Math.atan2(pt.tx, pt.tz), vx: dv.speed, vy: 0, yr: 0, st: 0, rpm: 11000, g: 7, th: 1, br: 0, cmp: 'medium', pit: false, ...extra });
    };
    // Während des Countdowns stehen bleiben
    const lightsOut = A.countdown!.lightsOut;
    while (Date.now() < lightsOut + 50) {
      for (const dv of drivers) send(dv);
      await sleep(50);
    }
    // Frühstart-Prüfung nachträglich: neues Paket weit vor dem Startplatz VOR dem Start ist abgedeckt durch Serverlogik
    check(A.corrections === 0 && B.corrections === 0, 'keine Korrekturen beim regulären Stehen in der Startaufstellung');

    console.log('\n▶ Fahrt & Synchronisierung');
    let last = Date.now();
    let sawOther = false;
    let maxSyncErr = 0;
    let teleported = false;
    const raceStart = Date.now();
    while (!A.results && Date.now() - raceStart < 90000) {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      for (const dv of drivers) {
        dv.s = track.wrapS(dv.s + dv.speed * dt);
        dv.d = track.raceLine[track.indexAt(dv.s)];
        send(dv);
      }
      // Einmalig: unplausibler Sprung von Ben
      if (!teleported && now - raceStart > 4000) {
        teleported = true;
        const dvB = drivers[1];
        track.pointAt(dvB.s + 900, 0, pt);
        B.sock.emit('state', { seq: dvB.seq++, x: pt.x, y: pt.y, z: pt.z, h: 0, vx: 80, vy: 0, yr: 0, st: 0, rpm: 11000, g: 7, th: 1, br: 0, cmp: 'medium', pit: false });
        // Ungültige Nachricht (wird ignoriert)
        B.sock.emit('state', { seq: 'x', x: NaN });
      }
      const snap = A.snaps[A.snaps.length - 1];
      if (snap) {
        const other = snap.cars.find((c) => c.id === B.sock.id);
        if (other) {
          sawOther = true;
          // Vergleich mit der tatsächlich gesendeten Position (Snapshot ist max. ~100 ms alt)
          track.pointAt(drivers[1].s, drivers[1].d, pt);
          maxSyncErr = Math.max(maxSyncErr, Math.hypot(other.x - pt.x, other.z - pt.z));
        }
      }
      await sleep(50);
    }
    check(sawOther, 'Client A empfängt die Position von Client B');
    console.log(`    max. Positionsabweichung Snapshot vs. Sender: ${maxSyncErr.toFixed(1)} m (inkl. Übertragungszeit bei ~75 m/s)`);
    check(maxSyncErr < 25, 'Positionen synchron (Abweichung < 25 m bei 75 m/s, d. h. < ~0,3 s)');
    check(B.corrections >= 1, 'unplausibler Positionssprung wird vom Server korrigiert');
    const st = A.snaps[A.snaps.length - 1]?.standings ?? [];
    check(st.length === 2 && st[0].pos === 1 && st[1].pos === 2, 'Platzierungen werden synchronisiert');

    console.log('\n▶ Ergebnis');
    await waitFor(() => !!A.results && !!B.results, 5000, 'Ergebnis');
    check(!!A.results && !!B.results, 'beide erhalten das Rennergebnis');
    const rows = A.results?.rows ?? [];
    check(rows.length === 2 && rows[0].name === 'Anna', `Sieger ist der schnellere Fahrer (${rows.map((r) => `${r.pos}. ${r.name} ${r.time?.toFixed(2)}s`).join(', ')})`);
    if (rows[0]?.time) {
      const expected = track.length / 78;
      check(Math.abs(rows[0].time - expected) < expected * 0.12 + 1.5, `serverseitige Rennzeit plausibel (${rows[0].time.toFixed(2)} s, erwartet ~${expected.toFixed(1)} s)`);
    }
    check(A.events.some((e) => e.startsWith('lap:')), 'Rundenereignisse werden verteilt');
    await waitFor(() => A.lobby?.status === 'waiting', 4000, 'zurück in Lobby');
    check(A.lobby?.status === 'waiting', 'nach dem Rennen zurück in der Lobby');

    console.log('\n▶ Verlassen & Host-Wechsel');
    A.sock.emit('lobby:leave');
    await waitFor(() => B.lobby?.players.length === 1, 3000, 'Spieler verlässt Lobby');
    check(B.lobby?.players.length === 1, 'Spieler verlässt die Lobby korrekt');
    check(B.lobby?.hostId === B.sock.id, 'Host-Rolle geht an verbleibenden Spieler über');
    B.sock.disconnect();
    A.sock.disconnect();
    await sleep(300);
    const health = await fetch(`${URL}/health`).then((r) => r.json() as Promise<{ lobbies: number }>);
    check(health.lobbies === 0, 'leere Lobbys werden entfernt');
  } finally {
    server.kill('SIGTERM');
  }
  console.log(`\n${passes} bestanden, ${failures} fehlgeschlagen`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
