// Anwendung: Zustandsmaschine (Menü/Laden/Rennen), Spielschleife und Verdrahtung aller Systeme.
import { AudioEngine } from '../audio/AudioEngine';
import { RaceController } from '../game/RaceController';
import { Input } from '../input/Input';
import { NetClient } from '../net/NetClient';
import { NetRaceSession } from '../net/NetRaceSession';
import { PodiumScene } from '../render/Podium';
import { Renderer } from '../render/Renderer';
import { Showroom } from '../render/Showroom';
import { SettingsStore } from '../settings';
import type { Compound } from '../shared/carPhysics';
import type { RaceLoadMsg } from '../shared/protocol';
import type { ResultRow } from '../sim/RaceSession';
import type { Driver, Team } from '../shared/teams';
import { getDriver } from '../shared/teams';
import { type GameMode, type SessionConfig } from '../sim/config';
import type { ISession } from '../sim/ISession';
import { RaceSession, type SessionKind } from '../sim/RaceSession';
import { getPreviewTrack, Menus } from '../ui/Menus';
import { TRACK_DEFS } from '../shared/trackDefs';

type AppState = 'menu' | 'loading' | 'race' | 'podium';

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class App {
  readonly settings = new SettingsStore();
  readonly renderer: Renderer;
  readonly input: Input;
  readonly audio = new AudioEngine();
  readonly net = new NetClient();
  readonly menus: Menus;
  private readonly showroom: Showroom;
  private race: RaceController | null = null;
  private session: ISession | null = null;
  private state: AppState = 'menu';
  private last = performance.now();
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fpsText = '';
  private orbitT = 0;
  private resultsShown = false;
  /** Siegerehrung (3D-Szene) und Automatik nach dem Zieleinlauf der ersten drei */
  private podium: PodiumScene | null = null;
  private podiumAutoDone = false;
  private podiumReadyFor = 0;
  private podiumCheckAcc = 0;
  private lastConfig: { cfg: SessionConfig; kind: SessionKind; grid?: string[] } | null = null;
  /** Ablaufdaten des aktuellen Menüflusses */
  readonly flow: { mode: GameMode; compound: Compound } = { mode: 'grandprix', compound: 'medium' };
  private readonly hudRoot: HTMLElement;
  private mpUnsub: (() => void)[] = [];

  constructor(canvasRoot: HTMLElement, uiRoot: HTMLElement, hudRoot: HTMLElement, overlayRoot: HTMLElement) {
    this.hudRoot = hudRoot;
    this.renderer = new Renderer(canvasRoot, this.settings.data.graphics.quality);
    this.input = new Input(this.settings.data);
    this.showroom = new Showroom(this.renderer);
    this.menus = new Menus(this, uiRoot, overlayRoot);
    this.audio.setVolumes(this.settings.data.audio);
    this.settings.onChange((s) => this.input.setSettings(s));
    // Audio erst nach Nutzerinteraktion starten
    const unlock = () => {
      this.audio.init();
      this.audio.setVolumes(this.settings.data.audio);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    // Tab-Wechsel: Einzelspieler pausieren, Zeit nicht aufholen
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === 'race' && this.race && this.session?.kind !== 'multiplayer' && !this.race.paused && !this.resultsShown) this.openPause();
        this.audio.silence();
      }
      this.last = performance.now();
    });
    // Multiplayer: Rennstart vom Server
    this.net.on('load', (m) => this.startMultiplayerRace(m));
    this.menus.main();
    if (!this.settings.data.firstRunDone) {
      this.menus.controlsHelp(() => this.settings.update((s) => (s.firstRunDone = true)));
    }
    requestAnimationFrame(this.loop);
    this.precomputePreviews();
  }

  /** Streckenvorschauen im Leerlauf berechnen, damit die Streckenauswahl ohne Ruckler öffnet. */
  private precomputePreviews(): void {
    const ids = TRACK_DEFS.map((d) => d.id);
    const idle = (cb: () => void) => {
      const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
      if (w.requestIdleCallback) w.requestIdleCallback(cb, { timeout: 2000 });
      else window.setTimeout(cb, 50);
    };
    const next = () => {
      const id = ids.shift();
      if (!id) return;
      if (this.state === 'menu') getPreviewTrack(id);
      else ids.unshift(id);
      idle(next);
    };
    idle(next);
  }

  click(): void {
    this.audio.init();
    this.audio.beep(1200, 0.03, 0.05);
  }

  showroomCar(team: Team, driver: Driver): void {
    this.showroom.setCar(team, driver);
  }

  applyQuality(): void {
    this.renderer.applyQuality(this.settings.data.graphics.quality);
  }

  applyRuntimeSettings(): void {
    this.race?.applySettings(this.settings.data);
    this.audio.setVolumes(this.settings.data.audio);
  }

  // ---------------------------------------------------------------- Schleife

  private loop = (now: number): void => {
    requestAnimationFrame(this.loop);
    // dt begrenzen: kein unkontrolliertes Beschleunigen nach Tab-Wechsel oder Rucklern
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fpsText = `${Math.round(this.fpsFrames / this.fpsAcc)} FPS`;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    try {
      if (this.state === 'race' && this.race) {
        if (this.renderer.scene !== this.race.scene) this.renderer.setScene(this.race.scene);
        if (this.resultsShown) {
          // Ergebnisanzeige: Simulation läuft (z. B. Auslaufrunde), Kamera kreist
          this.orbitT += dt;
          this.race.frame(dt);
          this.race.orbitCamera(dt, this.orbitT);
          this.checkAutoPodium(dt);
        } else {
          this.race.frame(dt);
        }
        this.race.hud.fps(this.settings.data.graphics.showFps ? this.fpsText : null);
        this.renderer.render();
      } else if (this.state === 'podium' && this.podium) {
        const cam = this.renderer.camera;
        this.podium.update(dt, cam, cam.aspect);
        if (this.renderer.scene !== this.podium.scene) this.renderer.setScene(this.podium.scene);
        this.renderer.render();
      } else if (this.state === 'menu') {
        this.showroom.update(dt, this.renderer.camera, this.renderer.camera.aspect);
        if (this.renderer.scene !== this.showroom.scene) this.renderer.setScene(this.showroom.scene);
        this.renderer.render();
      }
    } catch (e) {
      console.error(e);
      this.fatal(e as Error);
    }
  };

  private fatal(e: Error): void {
    if (this.state === 'race' || this.state === 'podium') {
      this.endRace();
      this.menus.main();
    }
    this.menus.error('Unerwarteter Fehler', `${e.message}. Das Rennen wurde beendet. Details stehen in der Browser-Konsole.`);
  }

  // ---------------------------------------------------------------- Abläufe

  /** Start aus der Rennkonfiguration. */
  startFromMenu(): void {
    const s = this.settings.data;
    const mode = this.flow.mode;
    const compound: Compound = s.race.weather === 'wet' && ['soft', 'medium', 'hard'].includes(this.flow.compound) ? 'inter' : this.flow.compound;
    const cfg: SessionConfig = {
      mode,
      trackId: s.race.trackId,
      laps: s.race.laps,
      weather: s.race.weather,
      difficulty: s.difficulty,
      playerDriverId: s.race.driverId,
      aiCount: s.race.aiCount,
      startMode: s.race.startMode,
      wearScale: mode === 'grandprix' ? s.race.wearScale : 1,
      startCompound: compound,
      transmission: s.transmission,
      assists: { ...s.assists },
      seed: (Math.random() * 1e9) >>> 0,
    };
    let kind: SessionKind = 'race';
    if (mode === 'timetrial') kind = 'timetrial';
    else if (mode === 'practice') kind = 'practice';
    else if (cfg.startMode === 'qualifying') kind = 'qualifying';
    void this.startSession(cfg, kind);
  }

  async startSession(cfg: SessionConfig, kind: SessionKind, gridOrder?: string[]): Promise<void> {
    this.lastConfig = { cfg, kind, grid: gridOrder };
    this.endRace();
    this.state = 'loading';
    this.menus.hide();
    const label = kind === 'qualifying' ? 'Qualifying' : kind === 'race' ? 'Grand Prix' : kind === 'timetrial' ? 'Zeitfahren' : 'Training';
    const ld = this.menus.loading(cfg.trackId, `${label} wird vorbereitet …`);
    try {
      await nextFrame();
      ld.set(0.15, 'Strecke und Ideallinie werden berechnet …');
      await nextFrame();
      const session = new RaceSession(cfg, kind, gridOrder);
      ld.set(0.45, 'Umgebung wird aufgebaut …');
      await nextFrame();
      this.mountRace(session);
      ld.set(0.85, 'Shader werden kompiliert …');
      await nextFrame();
      this.renderer.gl.compile(this.race!.scene, this.renderer.camera);
      ld.set(1, 'Bereit');
      await nextFrame();
      ld.done();
      this.state = 'race';
      if (kind === 'race') {
        this.race!.hud.message(`${cfg.laps} Runden · Startplatz P${session.player.position}`, 'info', 3000);
        window.setTimeout(() => session.startCountdown(), 1800);
      } else if (kind === 'qualifying') {
        this.race!.hud.message('Qualifying: Aufwärmrunde + 2 gezeitete Runden', 'info', 3500);
      } else if (kind === 'timetrial') {
        this.race!.hud.message('Zeitfahren: Die Zeitnahme startet an der Ziellinie', 'info', 3500);
      } else {
        this.race!.hud.message('Training: freies Fahren – Esc für Einstellungen', 'info', 3500);
      }
    } catch (e) {
      console.error(e);
      ld.done();
      this.state = 'menu';
      this.endRace();
      this.menus.main();
      this.menus.error('Laden fehlgeschlagen', (e as Error).message);
    }
  }

  private mountRace(session: ISession): void {
    this.session = session;
    this.resultsShown = false;
    this.podiumAutoDone = false;
    this.podiumReadyFor = 0;
    this.orbitT = 0;
    this.race = new RaceController(session, this.renderer, this.settings.data, this.input, this.audio, this.hudRoot, {
      onPause: () => this.openPause(),
      onPlayerFinished: () => this.showResults(),
      onFinished: () => this.showResults(),
    });
    this.renderer.setScene(this.race.scene);
    this.renderer.setBloom(session.track.def.env.floodlights ? 0.55 : 0.3);
    this.input.clearEdges();
  }

  endRace(): void {
    if (this.podium) {
      this.podium.dispose();
      this.podium = null;
    }
    for (const u of this.mpUnsub) u();
    this.mpUnsub = [];
    if (this.race) {
      this.race.dispose();
      this.race = null;
    }
    if (this.session instanceof NetRaceSession) this.session.dispose();
    this.session = null;
    this.resultsShown = false;
    this.renderer.setScene(this.showroom.scene);
    this.audio.silence();
    this.state = 'menu';
  }

  /** Die ersten drei stehen fest (im Ziel) bzw. das Rennen ist beendet. */
  private podiumReady(session: ISession, rows: ResultRow[]): boolean {
    if (session.phase === 'finished') return true;
    const top = rows.slice(0, 3);
    return top.length > 0 && top.every((r) => r.status === 'Im Ziel');
  }

  /** Nach dem Zieleinlauf der ersten drei: Siegerehrung automatisch starten, wenn du auf dem Podest stehst. */
  private checkAutoPodium(dt: number): void {
    const session = this.session;
    if (!session || this.podiumAutoDone || this.podium || (session.kind !== 'race' && session.kind !== 'multiplayer')) return;
    this.podiumCheckAcc += dt;
    if (this.podiumCheckAcc < 0.25) return;
    const step = this.podiumCheckAcc;
    this.podiumCheckAcc = 0;
    const rows = session.results();
    if (!this.podiumReady(session, rows)) {
      this.podiumReadyFor = 0;
      return;
    }
    this.podiumReadyFor += step;
    if (this.podiumReadyFor < 2.5) return;
    this.podiumAutoDone = true;
    if (rows.slice(0, 3).some((r) => r.carId === session.player.id)) this.showPodium();
  }

  /** Siegerehrung mit den ersten drei als 3D-Szene zeigen. */
  showPodium(): void {
    const race = this.race;
    const session = this.session;
    if (!race || !session || this.podium) return;
    let rows = session.results();
    // Einzelspieler: noch nicht alle drei im Ziel → Rennen werten (hochgerechnet)
    if (!this.podiumReady(session, rows) && session instanceof RaceSession) {
      session.forceFinish();
      rows = session.results();
    }
    const top = rows.slice(0, 3);
    if (!top.length) return;
    this.podiumAutoDone = true;
    const mp = session.kind === 'multiplayer';
    if (!mp) race.setPaused(true);
    else this.audio.silence();
    this.podium = new PodiumScene(
      this.renderer,
      top.map((r, i) => ({ position: (i + 1) as 1 | 2 | 3, driver: r.driver, team: r.team })),
      session.track.def.name,
    );
    this.state = 'podium';
    this.renderer.setScene(this.podium.scene);
    this.audio.celebrate();
    this.menus.podium({
      trackName: session.track.def.name,
      rows: top,
      playerCarId: session.player.id,
      menuLabel: mp ? 'Zur Lobby' : 'Hauptmenü',
      onContinue: () => this.closePodium(true),
      onMenu: () => {
        this.closePodium(false);
        this.endRace();
        if (mp) {
          if (this.net.lobby) this.menus.lobby();
          else this.menus.lobbyConnect();
        } else this.menus.main();
      },
    });
  }

  private closePodium(reopenResults: boolean): void {
    if (!this.podium) return;
    this.podium.dispose();
    this.podium = null;
    if (!this.race) return;
    this.state = 'race';
    this.renderer.setScene(this.race.scene);
    if (this.session?.kind !== 'multiplayer') this.race.setPaused(false);
    if (reopenResults) this.openResultsMenu();
  }

  private openPause(): void {
    const race = this.race;
    const session = this.session;
    if (!race || !session) return;
    const mp = session.kind === 'multiplayer';
    if (!mp) race.setPaused(true);
    race.hud.setVisible(!mp ? false : true);
    const resume = () => {
      this.menus.hide();
      race.setPaused(false);
      race.hud.setVisible(true);
      this.input.captureGameKeys = true;
    };
    const escHandler = (e: KeyboardEvent) => {
      if (this.settings.data.controls.bindings.pause.includes(e.code) && this.race === race && race.paused) {
        e.preventDefault();
        // Taste nicht an die Spieleingabe weiterreichen, sonst öffnet sich die Pause sofort wieder
        e.stopImmediatePropagation();
        window.removeEventListener('keydown', escHandler, true);
        resume();
      }
    };
    window.addEventListener('keydown', escHandler, true);
    this.input.captureGameKeys = false;
    this.menus.pause({
      multiplayer: mp,
      current: session.player.car.st.compound,
      next: session.player.nextCompound,
      onCompound: (c) => race.setNextCompound(c),
      pitRequested: session.player.pitRequest,
      onPitRequest: () => session.togglePitRequest(),
      onResume: () => {
        window.removeEventListener('keydown', escHandler, true);
        resume();
      },
      onRestart: () => {
        window.removeEventListener('keydown', escHandler, true);
        if (this.lastConfig) void this.startSession({ ...this.lastConfig.cfg, assists: { ...this.settings.data.assists }, transmission: this.settings.data.transmission }, this.lastConfig.kind, this.lastConfig.grid);
      },
      onQuit: () => {
        window.removeEventListener('keydown', escHandler, true);
        if (mp) {
          this.net.leaveLobby();
          this.endRace();
          this.menus.lobbyConnect();
        } else {
          this.endRace();
          this.menus.main();
        }
      },
    });
  }

  private showResults(): void {
    const race = this.race;
    const session = this.session;
    if (!race || !session || this.resultsShown) return;
    if (session.kind === 'timetrial' || session.kind === 'practice') return;
    this.resultsShown = true;
    race.hud.setVisible(false);
    this.input.captureGameKeys = false;
    this.openResultsMenu();
  }

  /** Ergebnisanzeige (auch nach der Siegerehrung erneut). */
  private openResultsMenu(): void {
    const session = this.session;
    if (!session) return;
    const toMenu = () => {
      this.endRace();
      this.menus.main();
    };
    if (session.kind === 'qualifying') {
      const rows = session.qualiResults ?? [];
      const playerRow = rows.find((r) => r.driver.id === session.player.driver.id);
      this.menus.results({
        title: 'Qualifying-Ergebnis',
        subtitle: `${session.track.def.name} · Startplatz P${playerRow?.position ?? '-'}`,
        rows: () => rows.map((r) => ({ ...r, carId: r.driver.id === session.player.driver.id ? -1 : r.carId })),
        playerCarId: -1,
        live: false,
        showRace: false,
        buttons: [
          { label: 'Hauptmenü', fn: toMenu },
          {
            label: 'Zum Rennen ▶',
            primary: true,
            fn: () => {
              const grid = rows.map((r) => r.driver.id);
              const cfg = { ...session.cfg, startMode: 'qualifying' as const, seed: (Math.random() * 1e9) >>> 0 };
              void this.startSession(cfg, 'race', grid);
            },
          },
        ],
      });
      return;
    }
    if (session.kind === 'multiplayer') {
      this.menus.results({
        title: session.phase === 'finished' ? 'Rennergebnis' : 'Zieleinlauf',
        subtitle: `${session.track.def.name} · Online · P${session.player.position}`,
        rows: () => session.results(),
        playerCarId: session.player.id,
        live: true,
        showRace: true,
        buttons: [
          { label: '🏆 Siegerehrung', fn: () => this.showPodium() },
          {
            label: 'Zur Lobby',
            primary: true,
            fn: () => {
              this.endRace();
              if (this.net.lobby) this.menus.lobby();
              else this.menus.lobbyConnect();
            },
          },
        ],
      });
      return;
    }
    const cfg = session.cfg;
    this.menus.results({
      title: 'Rennergebnis',
      subtitle: `${session.track.def.name} · ${cfg.laps} Runden · ${getDriver(cfg.playerDriverId).name}`,
      rows: () => session.results(),
      playerCarId: session.player.id,
      live: true,
      showRace: true,
      buttons: [
        { label: 'Hauptmenü', fn: toMenu },
        {
          label: 'Rennen beenden',
          fn: () => {
            session.forceFinish();
          },
        },
        { label: '🏆 Siegerehrung', fn: () => this.showPodium() },
        {
          label: 'Nochmal fahren',
          primary: true,
          fn: () => {
            if (this.lastConfig) void this.startSession({ ...this.lastConfig.cfg, seed: (Math.random() * 1e9) >>> 0 }, this.lastConfig.kind === 'qualifying' ? 'qualifying' : 'race', this.lastConfig.grid);
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------- Multiplayer

  private async startMultiplayerRace(m: RaceLoadMsg): Promise<void> {
    if (!this.net.lobby) return;
    this.endRace();
    this.state = 'loading';
    this.menus.hide();
    const ld = this.menus.loading(m.trackId, 'Online-Rennen wird geladen …');
    try {
      await nextFrame();
      const s = this.settings.data;
      const cfg: SessionConfig = {
        mode: 'multiplayer',
        trackId: m.trackId,
        laps: m.laps,
        weather: m.weather,
        difficulty: s.difficulty,
        playerDriverId: m.grid.find((g) => g.id === this.net.id)?.driverId ?? s.race.driverId,
        aiCount: 0,
        startMode: 'random',
        wearScale: 1,
        startCompound: m.weather === 'wet' ? 'inter' : 'medium',
        transmission: s.transmission,
        assists: { ...s.assists },
        seed: 1,
      };
      const session = new NetRaceSession(cfg, m, this.net);
      ld.set(0.45, 'Umgebung wird aufgebaut …');
      await nextFrame();
      this.mountRace(session);
      this.race!.setNetInfo(() => ({ connected: this.net.status === 'online', ping: this.net.ping, players: m.grid.length }));
      ld.set(0.85, 'Shader werden kompiliert …');
      await nextFrame();
      this.renderer.gl.compile(this.race!.scene, this.renderer.camera);
      ld.done();
      this.state = 'race';
      this.net.raceLoaded(m.raceId);
      this.race!.hud.message('Warte auf alle Spieler …', 'info', 3000);
      this.mpUnsub.push(
        this.net.on('status', (st) => {
          if (st === 'offline' && this.session === session) {
            this.endRace();
            this.menus.lobbyConnect();
            this.menus.error('Verbindung getrennt', 'Die Verbindung zum Multiplayer-Server wurde unterbrochen.');
          }
        }),
        this.net.on('results', () => {
          if (this.session === session && !this.resultsShown) this.showResults();
        }),
      );
    } catch (e) {
      console.error(e);
      ld.done();
      this.endRace();
      this.menus.lobbyConnect();
      this.menus.error('Online-Rennen konnte nicht geladen werden', (e as Error).message);
    }
  }
}
