// Socket.IO-Client mit Uhrensynchronisation, Ping-Messung und Lobby-Aktionen.
import { io, type Socket } from 'socket.io-client';
import type { Ack, CarStateMsg, CorrectionMsg, CountdownMsg, LobbySettings, LobbyState, RaceEventMsg, RaceLoadMsg, ResultsMsg, SnapshotMsg } from '../shared/protocol';
import { PROTOCOL_VERSION } from '../shared/protocol';

export interface NetEvents {
  lobby: LobbyState;
  load: RaceLoadMsg;
  countdown: CountdownMsg;
  snapshot: SnapshotMsg;
  correction: CorrectionMsg;
  results: ResultsMsg;
  raceEvent: RaceEventMsg;
  status: 'offline' | 'connecting' | 'online';
  error: string;
}

type Listener<T> = (v: T) => void;

export class NetClient {
  private socket: Socket | null = null;
  status: 'offline' | 'connecting' | 'online' = 'offline';
  id = '';
  lobby: LobbyState | null = null;
  ping = 0;
  private offset = 0;
  private offsetInit = false;
  private pingTimer: number | null = null;
  private listeners = new Map<keyof NetEvents, Set<Listener<unknown>>>();
  url = '';

  on<K extends keyof NetEvents>(evt: K, fn: Listener<NetEvents[K]>): () => void {
    let set = this.listeners.get(evt);
    if (!set) this.listeners.set(evt, (set = new Set()));
    set.add(fn as Listener<unknown>);
    return () => set!.delete(fn as Listener<unknown>);
  }

  private emitLocal<K extends keyof NetEvents>(evt: K, v: NetEvents[K]): void {
    const set = this.listeners.get(evt);
    if (set) for (const fn of [...set]) fn(v);
  }

  private setStatus(s: NetClient['status']): void {
    this.status = s;
    this.emitLocal('status', s);
  }

  /** Verbindet mit dem Server (leere URL = gleicher Ursprung / Vite-Proxy). */
  connect(url: string): Promise<void> {
    if (this.socket && this.status === 'online' && url === this.url) return Promise.resolve();
    this.disconnect();
    this.url = url;
    this.setStatus('connecting');
    return new Promise((resolve, reject) => {
      const opts = { auth: { protocol: PROTOCOL_VERSION }, transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 5, timeout: 6000 };
      const socket = url ? io(url, opts) : io(opts);
      this.socket = socket;
      let settled = false;
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Zeitüberschreitung beim Verbinden mit dem Server'));
          this.disconnect();
        }
      }, 8000);
      socket.on('connect', () => {
        this.id = socket.id ?? '';
        this.setStatus('online');
        this.startPing();
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          resolve();
        }
      });
      socket.on('connect_error', (err) => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(`Server nicht erreichbar (${err.message})`));
          this.disconnect();
        }
      });
      socket.on('disconnect', () => {
        this.setStatus('offline');
        this.lobby = null;
      });
      socket.on('server:error', (e: { message?: string }) => this.emitLocal('error', e?.message ?? 'Serverfehler'));
      socket.on('lobby:state', (s: LobbyState) => {
        this.lobby = s;
        this.emitLocal('lobby', s);
      });
      socket.on('race:load', (m: RaceLoadMsg) => this.emitLocal('load', m));
      socket.on('race:countdown', (m: CountdownMsg) => this.emitLocal('countdown', m));
      socket.on('snapshot', (m: SnapshotMsg) => this.emitLocal('snapshot', m));
      socket.on('race:correction', (m: CorrectionMsg) => this.emitLocal('correction', m));
      socket.on('race:results', (m: ResultsMsg) => this.emitLocal('results', m));
      socket.on('race:event', (m: RaceEventMsg) => this.emitLocal('raceEvent', m));
    });
  }

  disconnect(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.socket = null;
    this.lobby = null;
    if (this.status !== 'offline') this.setStatus('offline');
  }

  private startPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    const doPing = () => {
      const s = this.socket;
      if (!s || !s.connected) return;
      const t0 = performance.now();
      const wall0 = Date.now();
      s.timeout(4000).emit('time:ping', wall0, (err: unknown, ack: Ack<{ t: number; server: number }>) => {
        if (err || !ack?.ok || !ack.data) return;
        const rtt = performance.now() - t0;
        this.ping = Math.round(this.ping ? this.ping * 0.6 + rtt * 0.4 : rtt);
        const est = ack.data.server + rtt / 2 - Date.now();
        this.offset = this.offsetInit ? this.offset * 0.8 + est * 0.2 : est;
        this.offsetInit = true;
        s.emit('lobby:ping', this.ping);
      });
    };
    doPing();
    window.setTimeout(doPing, 300);
    window.setTimeout(doPing, 700);
    this.pingTimer = window.setInterval(doPing, 2000);
  }

  /** Geschätzte Serverzeit (ms). */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  private request<T = unknown>(evt: string, payload: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.connected) return resolve({ ok: false, error: 'Nicht verbunden' });
      this.socket.timeout(6000).emit(evt, payload, (err: unknown, ack: Ack<T>) => {
        if (err) resolve({ ok: false, error: 'Keine Antwort vom Server' });
        else resolve(ack ?? { ok: false, error: 'Leere Antwort' });
      });
    });
  }

  createLobby(name: string): Promise<Ack<{ code: string; id: string }>> {
    return this.request('lobby:create', { name });
  }

  joinLobby(code: string, name: string): Promise<Ack<{ code: string; id: string }>> {
    return this.request('lobby:join', { code, name });
  }

  leaveLobby(): void {
    this.socket?.emit('lobby:leave');
    this.lobby = null;
  }

  setDriver(driverId: string): Promise<Ack> {
    return this.request('lobby:driver', driverId);
  }

  setReady(ready: boolean): void {
    this.socket?.emit('lobby:ready', ready);
  }

  setSettings(s: LobbySettings): Promise<Ack> {
    return this.request('lobby:settings', s);
  }

  startRace(): Promise<Ack> {
    return this.request('lobby:start', null);
  }

  raceLoaded(raceId: string): void {
    this.socket?.emit('race:loaded', raceId);
  }

  sendState(s: CarStateMsg): void {
    this.socket?.volatile.emit('state', s);
  }
}
