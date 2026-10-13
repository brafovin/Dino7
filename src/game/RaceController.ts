// Läuft während einer Sitzung: fester Simulationstakt, Rendering, Kamera, HUD, Audio, Effekte.
import * as THREE from 'three';
import type { AudioEngine } from '../audio/AudioEngine';
import type { DriveInput, Input } from '../input/Input';
import { CameraRig } from '../render/CameraRig';
import { buildCar, type CarMeshParts, setCarCompound } from '../render/CarModel';
import { Particles, Rain, SkidMarks } from '../render/Effects';
import { BrakeMarker } from '../render/BrakeMarker';
import { PitCrew, type PitCarInfo } from '../render/PitCrew';
import { RacingLineView } from '../render/RacingLineView';
import type { Renderer } from '../render/Renderer';
import { TrackScene } from '../render/TrackScene';
import { type BestLapRecord, loadBestLaps, saveBestLap, type Settings } from '../settings';
import { type CarInput, COMPOUNDS, emptyInput, SURFACE_INFO } from '../shared/carPhysics';
import { clamp, formatTime, wrapAngle } from '../shared/math';
import { SURF_ASPHALT, SURF_CURB, SURF_GRASS, SURF_GRAVEL } from '../shared/track';
import { BrakeHintTracker, type BrakeState } from '../sim/brakeAdvice';
import type { ISession } from '../sim/ISession';
import { LapTrace } from '../sim/LapTrace';
import type { SessionCar, SessionEvent } from '../sim/RaceSession';
import { type HudData, type HudStanding, type SectorState, HUD } from '../ui/HUD';

export const FIXED_DT = 1 / 120;

interface CarView {
  sc: SessionCar;
  parts: CarMeshParts;
  compound: string;
  skidKey: number;
}

export interface RaceCallbacks {
  onPause(): void;
  onFinished(): void;
  onPlayerFinished(position: number): void;
}

export class RaceController {
  readonly session: ISession;
  readonly scene = new THREE.Scene();
  readonly trackScene: TrackScene;
  readonly hud: HUD;
  private readonly renderer: Renderer;
  private readonly settings: Settings;
  private readonly input: Input;
  private readonly audio: AudioEngine;
  private readonly cb: RaceCallbacks;
  private readonly rig: CameraRig;
  private readonly views: CarView[] = [];
  private readonly smoke = new Particles(false);
  private readonly sparks = new Particles(true);
  private readonly skids = new SkidMarks(this.lowQ() ? 1200 : 3000);
  private rain: Rain | null = null;
  private lineView: RacingLineView;
  private readonly brakeMarker: BrakeMarker;
  private readonly brakeTracker = new BrakeHintTracker();
  private brakeState: BrakeState | null = null;
  private readonly pitCrew: PitCrew;
  private readonly pitInfos: PitCarInfo[] = [];
  private lastPitDoneAt = -100;
  private acc = 0;
  paused = false;
  private readonly drive: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, lookBack: false };
  private readonly carInput: CarInput = emptyInput();
  private pendingShiftUp = false;
  private pendingShiftDown = false;
  private hudTimer = 0;
  private finishedNotified = false;
  private playerFinishNotified = false;
  private sectorBest: (number | null)[] = [null, null, null];
  private showLastSectorsUntil = 0;
  private lastSectorsShown: (number | null)[] = [null, null, null];
  private lastSectorStates: SectorState[] = ['none', 'none', 'none'];
  private trace = new LapTrace();
  private bestTrace: LapTrace | null = null;
  private ghost: CarMeshParts | null = null;
  private ghostPose = [0, 0, 0, 0];
  private bestRecord: BestLapRecord | null = null;
  private fuelAtLapStart = 0;
  private fuelPerLap: number | null = null;
  private lastLightCount = -1;
  private curbShake = 0;
  private resetCooldown = 0;
  private emitTimer = 0;
  private readonly tmpV = new THREE.Vector3();
  private disposed = false;
  private netInfo: (() => { connected: boolean; ping: number; players: number }) | null = null;

  constructor(session: ISession, renderer: Renderer, settings: Settings, input: Input, audio: AudioEngine, hudRoot: HTMLElement, cb: RaceCallbacks) {
    this.session = session;
    this.renderer = renderer;
    this.settings = settings;
    this.input = input;
    this.audio = audio;
    this.cb = cb;
    const q = settings.graphics.quality;
    this.trackScene = new TrackScene(session.track, { quality: q, weather: session.cfg.weather });
    this.scene.add(this.trackScene.group);
    this.scene.fog = this.trackScene.fog;
    this.scene.background = this.trackScene.bgColor;
    // Umgebungsreflexionen aus dem Himmel
    try {
      const pmrem = new THREE.PMREMGenerator(renderer.gl);
      const envScene = new THREE.Scene();
      envScene.add(this.trackScene.sky.clone());
      const rt = pmrem.fromScene(envScene, 0.04);
      this.scene.environment = rt.texture;
      pmrem.dispose();
    } catch {
      /* optional */
    }
    this.lineView = new RacingLineView(session.track, session.line);
    this.scene.add(this.lineView.mesh);
    this.brakeMarker = new BrakeMarker(session.track);
    this.scene.add(this.brakeMarker.group);
    this.pitCrew = new PitCrew(session.track);
    this.scene.add(this.pitCrew.group);
    this.scene.add(this.smoke.points, this.sparks.points, this.skids.mesh);
    if (session.cfg.weather === 'wet') {
      this.rain = new Rain(q === 'low' ? 1200 : q === 'medium' ? 2200 : 3500);
      this.scene.add(this.rain.lines);
    }
    const detail = q === 'high' ? 2 : q === 'medium' ? 2 : 1;
    session.cars.forEach((sc, k) => {
      const parts = buildCar(sc.team, sc.driver, sc.isPlayer ? 2 : detail, sc.car.st.compound);
      this.scene.add(parts.root);
      this.views.push({ sc, parts, compound: sc.car.st.compound, skidKey: k * 4 });
    });
    this.rig = new CameraRig(renderer.camera);
    this.rig.mode = settings.camera.mode;
    this.rig.baseFov = settings.camera.fov;
    this.rig.shakeEnabled = settings.camera.shake;
    this.rig.setTrack(session.track, (x, z) => this.trackScene.terrainHeight(x, z));
    this.hud = new HUD(hudRoot);
    this.hud.setTrack(session.track);
    // Bestzeit / Geist (Zeitfahren)
    const best = loadBestLaps()[session.track.def.id];
    if (best) {
      this.bestRecord = best;
      if (session.kind === 'timetrial' && best.ghost && best.ghost.length > 12) this.bestTrace = LapTrace.from(best.ghost);
    }
    if (this.bestTrace) {
      const g = buildCar(session.player.team, session.player.driver, 1);
      g.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m) {
          const c = m.clone();
          c.transparent = true;
          c.opacity = 0.35;
          c.depthWrite = false;
          (o as THREE.Mesh).material = c;
          (o as THREE.Mesh).castShadow = false;
        }
      });
      this.ghost = g;
      g.root.visible = false;
      this.scene.add(g.root);
    }
    this.fuelAtLapStart = session.player.car.st.fuel;
    this.input.captureGameKeys = true;
    if (session.kind === 'race' || session.kind === 'multiplayer') this.hud.hint('Startaufstellung – warte auf die Ampel');
    this.updateVisuals(1);
    this.rig.update(0.016, session.player.car.st, false, 0);
  }

  private lowQ(): boolean {
    return this.settings?.graphics.quality === 'low';
  }

  setNetInfo(fn: () => { connected: boolean; ping: number; players: number }): void {
    this.netInfo = fn;
  }

  applySettings(s: Settings): void {
    this.rig.baseFov = s.camera.fov;
    this.rig.shakeEnabled = s.camera.shake;
    if (this.rig.mode !== s.camera.mode) this.rig.mode = s.camera.mode;
    this.session.player.car.assists = {
      ...this.session.player.car.assists,
      tc: s.assists.tc === 'off' ? 0 : s.assists.tc === 'low' ? 1 : 2,
      abs: s.assists.abs,
      steering: s.assists.steering,
      autoGear: s.transmission === 'auto',
    };
    (this.session.cfg as { assists: typeof s.assists }).assists = { ...s.assists };
  }

  /** Ein Frame. dt in Sekunden (bereits begrenzt). */
  frame(dt: number): void {
    if (this.disposed) return;
    const s = this.session;
    const inp = this.input;
    // Eingaben
    inp.poll(dt, this.drive);
    if (inp.consume('pause')) {
      if (!this.paused) this.cb.onPause();
    }
    if (inp.consume('camera')) {
      const m = this.rig.cycle();
      this.settings.camera.mode = m;
      this.hud.message(cameraName(m), 'info', 1200);
    }
    if (inp.consume('pit') && !this.paused && (s.kind !== 'race' || s.phase === 'racing') && !s.player.finished) s.togglePitRequest();
    if (inp.consume('shiftUp')) this.pendingShiftUp = true;
    if (inp.consume('shiftDown')) this.pendingShiftDown = true;
    this.resetCooldown = Math.max(0, this.resetCooldown - dt);
    if (inp.consume('reset') && !this.paused && s.phase === 'racing' && this.resetCooldown <= 0 && s.player.pitTimer <= 0) {
      s.resetCar(s.player);
      this.resetCooldown = 2;
      this.hud.message('Fahrzeug zurückgesetzt', 'info', 1200);
    }

    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= FIXED_DT && steps < 12) {
        const ci = this.carInput;
        ci.throttle = this.drive.throttle;
        ci.brake = this.drive.brake;
        ci.steer = this.drive.steer;
        ci.handbrake = this.drive.handbrake;
        ci.steerAngle = undefined;
        ci.shiftUp = this.pendingShiftUp;
        ci.shiftDown = this.pendingShiftDown;
        this.pendingShiftUp = false;
        this.pendingShiftDown = false;
        s.step(FIXED_DT, ci);
        const pc = s.player.car;
        if (pc.shiftedThisStep) this.audio.shift();
        if (pc.overRevDenied) this.hud.message('Runterschalten verweigert – Drehzahl zu hoch', 'warn', 1200);
        this.acc -= FIXED_DT;
        steps++;
      }
      if (steps >= 12) this.acc = 0;
      this.handleEvents(s.drainEvents());
      this.recordTrace();
    }
    const alpha = s.localSim ? clamp(this.acc / FIXED_DT, 0, 1) : 1;
    this.updateVisuals(alpha);

    // Kamera
    const pst = s.player.car.st;
    this.curbShake = pst.curb > 0 ? clamp(pst.speed / 40, 0, 1) * pst.curb : pst.offTrack * clamp(pst.speed / 30, 0, 1) * 0.6;
    this.rig.update(dt, pst, this.drive.lookBack, this.curbShake);
    const camPos = this.renderer.camera.position;
    this.trackScene.update(dt, camPos);
    this.tmpV.set(pst.x, pst.y, pst.z);
    this.trackScene.updateSun(this.tmpV);
    // Effekte
    this.emitEffects(dt);
    this.smoke.setScale(this.renderer.gl.domElement.height, this.renderer.camera.fov);
    this.sparks.setScale(this.renderer.gl.domElement.height, this.renderer.camera.fov);
    this.smoke.update(this.paused ? 0 : dt);
    this.sparks.update(this.paused ? 0 : dt);
    if (this.rain) {
      const vel = new THREE.Vector3(Math.sin(pst.heading) * pst.vx, 0, Math.cos(pst.heading) * pst.vx);
      this.rain.update(this.paused ? 0 : dt, camPos, vel);
    }
    // Boxencrews und Ausfahrtsampel
    this.pitInfos.length = 0;
    for (const c of s.cars) {
      const incoming = !c.pitServed && (c.pitRequest || (c.ai !== null && c.ai.pitBox !== null)) && s.inPitLane(c);
      if (incoming || c.pitTimer > 0) this.pitInfos.push({ teamIndex: c.teamIndex, incoming, stopped: c.pitTimer > 0 });
    }
    this.pitCrew.update(this.paused ? 0 : dt, this.pitInfos, s.phase === 'racing' || s.phase === 'finished');
    // Bremshinweis (Bremslinie) und Ideallinie
    const me = s.player;
    const hintOn = this.settings.assists.brakeHint && s.phase === 'racing' && !me.finished && !s.pitPilot && me.pitTimer <= 0 && !s.inPitLane(me);
    if (!hintOn) {
      this.brakeTracker.reset();
      this.brakeState = null;
    } else if (!this.paused) this.brakeState = this.brakeTracker.update(s.track, s.playerProfile.v, pst.s, pst.vx);
    this.brakeMarker.update(this.paused ? 0 : dt, this.brakeState, pst.vx);
    this.lineView.update(this.settings.assists.line, pst.s, pst.vx, s.playerProfile.v, this.brakeState?.advice ?? null);
    // Startampel
    const lights = s.phase === 'countdown' ? s.lights : -1;
    if (lights !== this.lastLightCount) {
      if (lights > 0 && lights > this.lastLightCount) this.audio.beep(660, 0.12, 0.12);
      this.lastLightCount = lights;
      this.trackScene.setStartLights(Math.max(0, lights));
      this.hud.setLights(s.phase === 'countdown' ? Math.max(0, lights) : -1);
    }
    // Audio
    this.updateAudio(dt);
    // HUD (gedrosselt)
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 1 / 30;
      this.hud.update(this.buildHud());
    }
    // Ende
    if (!this.playerFinishNotified && s.player.finished && (s.kind === 'race' || s.kind === 'multiplayer')) {
      this.playerFinishNotified = true;
      this.hud.big(`Ziel · P${s.player.position}`, 4000);
      window.setTimeout(() => {
        if (!this.disposed) this.cb.onPlayerFinished(s.player.position);
      }, 3500);
    }
    if (!this.finishedNotified && s.phase === 'finished') {
      this.finishedNotified = true;
      if (s.kind === 'qualifying') this.hud.big('Qualifying beendet', 2500);
      window.setTimeout(() => {
        if (!this.disposed) this.cb.onFinished();
      }, s.kind === 'qualifying' ? 2200 : 300);
    }
  }

  private recordTrace(): void {
    const s = this.session;
    const p = s.player;
    const lt = p.lap;
    if (!lt.timing || lt.preLine) return;
    const t = s.time - lt.lapStart;
    const st = p.car.st;
    const last = this.trace.s.length ? this.trace.s[this.trace.s.length - 1] : -100;
    if (st.s - last > 8 || this.trace.s.length === 0) this.trace.add(st.s, t, st.x, st.y, st.z, st.heading);
  }

  private handleEvents(events: SessionEvent[]): void {
    const s = this.session;
    const me = s.player.id;
    for (const e of events) {
      switch (e.type) {
        case 'message':
          if (e.carId === undefined || e.carId === me) this.hud.message(e.text, e.tone);
          break;
        case 'go':
          this.hud.setLights(-1);
          this.hud.hint(null);
          this.hud.big('Los!', 900);
          this.audio.beep(990, 0.25, 0.15);
          break;
        case 'lights':
          break;
        case 'impact': {
          const strength = e.speed;
          this.sparks.emit({ x: e.x, y: e.y, z: e.z, vy: 2, life: 0, max: 0.3, size: 0.25, r: 1, g: 0.7, b: 0.3, a: 1 });
          for (let k = 0; k < Math.min(40, strength * 3); k++) {
            this.sparks.emit({
              x: e.x,
              y: e.y,
              z: e.z,
              vx: (Math.random() - 0.5) * 14,
              vy: Math.random() * 6,
              vz: (Math.random() - 0.5) * 14,
              max: 0.3 + Math.random() * 0.5,
              size: 0.12,
              grow: -0.1,
              r: 1,
              g: 0.65,
              b: 0.25,
              a: 1,
              grav: 12,
              drag: 1.5,
            });
          }
          if (e.carId === me) {
            this.audio.impact(strength);
            this.input.rumble(clamp(strength / 15, 0.2, 1), 0.6, 250);
            this.rig.bump = clamp(strength / 12, 0.2, 1.5);
          }
          break;
        }
        case 'sector': {
          const prev = this.sectorBest[e.sector];
          if (prev === null || e.split < prev) this.sectorBest[e.sector] = e.split;
          break;
        }
        case 'lap': {
          const c = s.cars[e.carId];
          const s3 = c.lap.lastSectors[2];
          if (e.valid && s3 !== null && (this.sectorBest[2] === null || s3 < (this.sectorBest[2] as number))) this.sectorBest[2] = s3;
          if (e.carId === me) this.onPlayerLap(e.lapTime, e.valid, e.best);
          else if (e.best && s.kind !== 'practice') this.hud.message(`Schnellste Runde: ${c.driver.code} ${formatTime(e.lapTime)}`, 'purple', 2000);
          break;
        }
        case 'pit':
          if (e.carId === me && e.stage === 'out') {
            this.input.rumble(0.3, 0.3, 200);
            this.lastPitDoneAt = s.time;
          }
          if (e.carId === me && e.stage === 'in') this.audio.beep(520, 0.15, 0.1);
          break;
        case 'finish':
          break;
        case 'reset':
          for (let w = 0; w < 4; w++) this.skids.break(e.carId * 4 + w);
          break;
      }
    }
  }

  private onPlayerLap(lapTime: number, valid: boolean, overallBest: boolean): void {
    const s = this.session;
    const p = s.player;
    const st = p.car.st;
    // Kraftstoff pro Runde
    const used = this.fuelAtLapStart - st.fuel;
    if (used > 0.05) this.fuelPerLap = this.fuelPerLap === null ? used : this.fuelPerLap * 0.5 + used * 0.5;
    this.fuelAtLapStart = st.fuel;
    this.lastSectorsShown = p.lap.lastSectors.slice();
    this.lastSectorStates = this.lastSectorsShown.map((t, i) => this.sectorState(t, i, p.lap.bestSectors[i]));
    this.showLastSectorsUntil = s.time + 4;
    const trace = this.trace;
    this.trace = new LapTrace();
    if (!valid) {
      this.hud.message(`Runde ungültig · ${formatTime(lapTime)}`, 'bad');
      return;
    }
    const isPB = p.lap.bestLap === lapTime;
    if (isPB) this.bestTrace = trace;
    if (s.kind === 'timetrial' || s.kind === 'practice') {
      const rec = this.bestRecord;
      if (!rec || lapTime < rec.time) {
        const nr: BestLapRecord = { time: lapTime, sectors: p.lap.lastSectors.slice(), driverId: p.driver.id, date: Date.now(), ghost: trace.serialize() };
        saveBestLap(s.track.def.id, nr);
        this.bestRecord = nr;
        if (s.kind === 'timetrial') this.bestTrace = trace;
        this.hud.message(`Neuer persönlicher Rekord: ${formatTime(lapTime)}`, 'purple', 3200);
        return;
      }
    }
    if (overallBest && s.kind !== 'practice') this.hud.message(`Schnellste Runde: ${formatTime(lapTime)}`, 'purple');
    else this.hud.message(`Runde ${formatTime(lapTime)}${isPB ? ' · persönliche Bestzeit' : ''}`, isPB ? 'good' : 'info', 2200);
  }

  private sectorState(t: number | null, i: number, personal: number | null): SectorState {
    if (t === null) return 'none';
    const overall = this.sectorBest[i];
    if (overall !== null && t <= overall + 1e-6) return 'purple';
    if (personal !== null && t <= personal + 1e-6) return 'green';
    return 'yellow';
  }

  // ---------------------------------------------------------------- Darstellung

  private updateVisuals(alpha: number): void {
    const s = this.session;
    const wet = s.cfg.weather === 'wet';
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    for (const v of this.views) {
      const st = v.sc.car.st;
      const p = v.sc.prev;
      const root = v.parts.root;
      const a = s.localSim ? alpha : 1;
      const x = p.x + (st.x - p.x) * a;
      const y = p.y + (st.y - p.y) * a;
      const z = p.z + (st.z - p.z) * a;
      const hdg = p.heading + wrapAngle(st.heading - p.heading) * a;
      const vib = st.curb > 0 ? (Math.random() - 0.5) * 0.02 * Math.min(1, st.speed / 30) : 0;
      // Im Boxenstopp aufgebockt
      root.position.set(x, y + vib + (v.sc.pitTimer > 0 ? 0.07 : 0), z);
      root.rotation.set(-st.pitch, hdg, st.roll, 'YXZ');
      v.parts.body.rotation.set(-st.bodyPitch, 0, st.bodyRoll);
      v.parts.wheels.forEach((w, i) => {
        w.pivot.rotation.y = w.front ? st.steer : 0;
        w.spin.rotation.x = st.wheelRot[i];
      });
      const braking = v.sc.input.brake > 0.15 && st.speed > 1;
      v.parts.brakeMat.emissiveIntensity = braking ? 4 : wet ? (blink ? 2.5 : 0.2) : 0.25;
      if (v.compound !== st.compound) {
        setCarCompound(v.parts, v.sc.team, st.compound);
        v.compound = st.compound;
      }
      // Geisterstatus (nach Reset) halbtransparent blinken
      root.visible = !(v.sc.ghostTimer > 0 && Math.floor(performance.now() / 120) % 2 === 0);
    }
    // Geisterauto (Zeitfahren)
    if (this.ghost && this.bestTrace) {
      const lt = s.player.lap;
      const t = lt.timing && !lt.preLine ? s.time - lt.lapStart : -1;
      const ok = t >= 0 && this.bestTrace.poseAt(t, this.ghostPose);
      this.ghost.root.visible = ok;
      if (ok) {
        this.ghost.root.position.set(this.ghostPose[0], this.ghostPose[1], this.ghostPose[2]);
        this.ghost.root.rotation.set(0, this.ghostPose[3], 0);
      }
    }
  }

  private emitEffects(dt: number): void {
    if (this.paused) return;
    this.emitTimer += dt;
    const step = 1 / 45;
    if (this.emitTimer < step) return;
    this.emitTimer = 0;
    const cam = this.renderer.camera.position;
    const wet = this.session.cfg.weather === 'wet';
    const wheelOff: [number, number][] = [
      [1.98, 0.8],
      [1.98, -0.8],
      [-1.62, 0.78],
      [-1.62, -0.78],
    ];
    for (const v of this.views) {
      const st = v.sc.car.st;
      const dx = st.x - cam.x;
      const dz = st.z - cam.z;
      if (dx * dx + dz * dz > 220 * 220) continue;
      const fx = Math.sin(st.heading);
      const fz = Math.cos(st.heading);
      const lx = Math.cos(st.heading);
      const lz = -Math.sin(st.heading);
      for (let i = 0; i < 4; i++) {
        const [px, py] = wheelOff[i];
        const wx = st.x + fx * px + lx * py;
        const wz = st.z + fz * px + lz * py;
        const wy = st.y + 0.05;
        const surf = st.surface[i];
        const slide = st.slide[i];
        const onTarmac = surf === SURF_ASPHALT || surf === SURF_CURB || SURFACE_INFO[surf]?.drag === 0;
        // Bremsspuren
        if (onTarmac && slide > 0.45 && st.speed > 4) this.skids.add(v.skidKey + i, wx, wy, wz, lx, lz, i < 2 ? 0.28 : 0.38, slide);
        else this.skids.break(v.skidKey + i);
        // Reifenrauch
        if (onTarmac && slide > 0.55 && st.speed > 6 && !wet) {
          this.smoke.emit({ x: wx, y: wy + 0.2, z: wz, vx: -fx * st.vx * 0.15 + (Math.random() - 0.5), vy: 0.6 + Math.random() * 0.5, vz: -fz * st.vx * 0.15 + (Math.random() - 0.5), max: 1.4 + Math.random(), size: 0.6, grow: 1.8, r: 0.85, g: 0.85, b: 0.87, a: 0.35 * slide, drag: 1.4 });
        }
        // Schmutz von Gras/Kies
        if ((surf === SURF_GRASS || surf === SURF_GRAVEL) && st.speed > 6 && i >= 2) {
          const col = surf === SURF_GRAVEL ? [0.66, 0.58, 0.45] : [0.4, 0.33, 0.2];
          this.smoke.emit({ x: wx, y: wy + 0.1, z: wz, vx: -fx * st.vx * 0.3 + (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 2, vz: -fz * st.vx * 0.3 + (Math.random() - 0.5) * 2, max: 0.9, size: 0.35, grow: 1.2, r: col[0], g: col[1], b: col[2], a: 0.6, grav: 4, drag: 1.2 });
        }
        // Gischt bei Nässe
        if (wet && i >= 2 && st.speed > 12) {
          this.smoke.emit({ x: wx - fx * 0.5, y: wy + 0.3, z: wz - fz * 0.5, vx: -fx * st.vx * 0.35 + (Math.random() - 0.5) * 2, vy: 0.6 + Math.random(), vz: -fz * st.vx * 0.35 + (Math.random() - 0.5) * 2, max: 0.8 + Math.random() * 0.6, size: 1.0, grow: 3.5, r: 0.82, g: 0.85, b: 0.88, a: 0.16 * clamp(st.speed / 60, 0, 1), drag: 1.8 });
        }
      }
      // Funken vom Unterboden bei hohem Tempo über Curbs/Kuppen
      if (st.speed > 62 && (st.curb > 0.2 || Math.random() < 0.015)) {
        for (let k = 0; k < 4; k++) {
          this.sparks.emit({ x: st.x - fx * 1.6, y: st.y + 0.04, z: st.z - fz * 1.6, vx: -fx * st.vx * 0.25 + (Math.random() - 0.5) * 3, vy: Math.random() * 1.5, vz: -fz * st.vx * 0.25 + (Math.random() - 0.5) * 3, max: 0.25 + Math.random() * 0.25, size: 0.08, r: 1, g: 0.75, b: 0.35, a: 1, grav: 9, drag: 2 });
        }
      }
      if (st.scrape > 0.5 && st.speed > 4) {
        this.sparks.emit({ x: st.x, y: st.y + 0.3, z: st.z, vx: (Math.random() - 0.5) * 6, vy: Math.random() * 3, vz: (Math.random() - 0.5) * 6, max: 0.35, size: 0.1, r: 1, g: 0.7, b: 0.3, a: 1, grav: 9 });
      }
    }
  }

  private updateAudio(dt: number): void {
    if (this.paused) {
      this.audio.silence();
      return;
    }
    const s = this.session;
    const p = s.player;
    const st = p.car.st;
    const slipLat = Math.max(...st.slide);
    this.audio.update(
      dt,
      {
        rpm: st.rpm,
        throttle: p.input.throttle,
        speed: st.speed,
        slip: slipLat,
        lockup: st.lockup,
        wheelspin: st.wheelspin,
        brake: p.input.brake,
        curb: st.curb,
        offTrack: st.offTrack,
        limiter: st.rpm >= p.car.p.maxRpm - 30,
        scrape: st.scrape,
      },
      { crowd: 1, rain: s.cfg.weather === 'wet' },
    );
    // Gegner (die drei nächsten)
    const cam = this.renderer.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const others = s.cars
      .filter((c) => c !== p)
      .map((c) => ({ c, d: (c.car.st.x - cam.position.x) ** 2 + (c.car.st.z - cam.position.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .filter((o) => o.d < 250 * 250)
      .map(({ c }) => {
        const cs = c.car.st;
        const rx = cs.x - cam.position.x;
        const rz = cs.z - cam.position.z;
        const dist = Math.hypot(rx, rz) || 1;
        const vX = Math.sin(cs.heading) * cs.vx - Math.sin(st.heading) * st.vx;
        const vZ = Math.cos(cs.heading) * cs.vx - Math.cos(st.heading) * st.vx;
        return { x: cs.x, y: cs.y + 0.5, z: cs.z, rpm: cs.rpm, throttle: c.input.throttle, radialVel: (vX * rx + vZ * rz) / dist };
      });
    this.audio.updateOpponents({ x: cam.position.x, y: cam.position.y, z: cam.position.z, fx: dir.x, fy: dir.y, fz: dir.z }, others);
    // Vibration bei Curbs / Blockieren
    if (st.curb > 0 && st.speed > 15) this.input.rumble(0.15, 0.4 * st.curb, 60);
    else if (st.lockup > 0.3 || st.wheelspin > 0.3) this.input.rumble(0.1, 0.3, 60);
  }

  private buildHud(): HudData {
    const s = this.session;
    const p = s.player;
    const st = p.car.st;
    const lt = p.lap;
    const kind = s.kind;
    const race = kind === 'race' || kind === 'multiplayer';
    // Sektoren
    let sectors: HudData['sectors'];
    if (s.time < this.showLastSectorsUntil) sectors = this.lastSectorsShown.map((t, i) => ({ time: t, state: this.lastSectorStates[i] }));
    else
      sectors = lt.curSectors.map((t, i) => ({ time: t, state: this.sectorState(t, i, lt.bestSectors[i]) }));
    // Delta zur besten Runde
    let delta: number | null = null;
    const cur = lt.timing && !lt.preLine ? s.time - lt.lapStart : null;
    const ref = this.bestTrace;
    if (cur !== null && ref) {
      const tRef = ref.timeAt(st.s);
      if (tRef !== null) delta = cur - tRef;
    }
    // Rangliste
    const sorted = s.cars.slice().sort((a, b) => a.position - b.position);
    const running = s.phase === 'racing' || s.phase === 'finished';
    const standings: HudStanding[] = race
      ? sorted.map((c) => ({
          id: c.id,
          position: c.position,
          code: c.playerName ? c.playerName.slice(0, 3).toUpperCase() : c.driver.code,
          color: c.team.livery.primary,
          gap: c.position === 1 ? (c.finished ? 'Ziel' : 'Führt') : running ? fmtGap(c.gapAhead) : '',
          me: c === p,
          pit: c.pitTimer > 0,
        }))
      : [];
    const behind = sorted.find((c) => c.position === p.position + 1);
    const lapsLeft = s.totalLaps - lt.completed;
    const lapNo = lt.completed + 1;
    const fuelLaps = race && this.fuelPerLap ? st.fuel / this.fuelPerLap - lapsLeft : null;
    const mapDots = s.cars.map((c) => ({ x: c.car.st.x, z: c.car.st.z, color: c.team.livery.primary, me: c === p }));
    if (this.ghost && this.ghost.root.visible) mapDots.push({ x: this.ghostPose[0], z: this.ghostPose[2], color: '#ffffff', me: false, ghost: true } as never);
    const sessionBest = kind === 'timetrial' || kind === 'practice' ? (this.bestRecord?.time ?? null) : (s.bestLapOverall?.time ?? null);
    // Boxen-Panel
    let pit: HudData['pit'] = null;
    const cmpName = COMPOUNDS[p.nextCompound].name;
    if (p.pitTimer > 0) {
      const done = 1 - p.pitTimer / Math.max(0.1, p.pitDuration);
      pit = { title: `Boxenstopp ${(p.pitDuration - p.pitTimer).toFixed(1)} s`, detail: `Reifenwechsel auf ${cmpName}`, tone: 'warn', progress: done };
    } else if (s.time - this.lastPitDoneAt < 4 && p.lastPitStop !== null) {
      pit = { title: `Standzeit ${p.lastPitStop.toFixed(1)} s`, detail: s.pitPilot ? 'Assistent fährt zur Ausfahrt' : 'Freigabe – auf die Ampel achten', tone: 'good', progress: 1 };
    } else if (s.inPitLane(p)) {
      pit = { title: 'Boxengasse', detail: s.pitPilot ? `Assistent aktiv · Tempolimit 80 km/h` : p.pitServed ? 'Zur Ausfahrt' : `Box: ${p.team.short} · Tempolimit 80 km/h`, tone: 'info', progress: null };
    } else if (p.pitRequest) {
      const dist = Math.round(s.track.deltaS(st.s, s.track.pit.sEntry) < 0 ? s.track.length + s.track.deltaS(st.s, s.track.pit.sEntry) : s.track.deltaS(st.s, s.track.pit.sEntry));
      pit = { title: 'Box, Box!', detail: `Einfahrt in ${dist} m · ${cmpName} · ${s.track.pit.side > 0 ? 'links' : 'rechts'} rein`, tone: 'warn', progress: null };
    }
    // Bremshinweis im HUD (ab ca. 2,6 s vor dem Bremspunkt)
    let brake: HudData['brake'] = null;
    const bs = this.brakeState;
    if (bs && !pit) {
      const lead = Math.max(70, Math.max(0, st.vx) * 2.6);
      if (bs.dist <= lead) {
        const reached = bs.dist <= 0;
        const strong = bs.advice.strong;
        const kmh = Math.round(bs.advice.vTarget * 3.6);
        brake = {
          title: strong ? (reached ? 'Bremsen!' : 'Bremsen') : 'Gas weg',
          detail: reached ? `auf ${kmh} km/h` : `in ${Math.max(0, Math.round(bs.dist))} m · ${kmh} km/h`,
          tone: strong ? 'brake' : 'lift',
          urgent: reached && (strong ? p.input.brake < 0.5 : p.input.throttle > 0.3),
          progress: clamp(1 - bs.dist / lead, 0, 1),
        };
      }
    }
    return {
      mode: kind,
      lap: lapNo,
      totalLaps: s.totalLaps,
      position: p.position,
      carCount: s.cars.length,
      driverName: p.playerName ?? p.driver.name,
      teamName: p.team.name,
      teamColor: p.team.livery.primary,
      number: p.driver.number,
      speedKmh: Math.abs(st.vx) * 3.6,
      gear: st.shiftTimer > 0 ? st.pendingGear : st.gear,
      rpm: st.rpm,
      maxRpm: p.car.p.maxRpm,
      currentLap: race ? (s.phase === 'racing' && !p.finished ? cur ?? s.time - s.goTime : null) : cur,
      lastLap: lt.lastLap,
      bestLap: lt.bestLap,
      sessionBest,
      lapInvalid: lt.invalid,
      sectors,
      delta,
      gapAhead: race && running && p.position > 1 ? fmtGap(p.gapAhead) || null : null,
      gapBehind: race && running && behind ? fmtGap(behind.gapAhead) || null : null,
      standings,
      tyreWear: st.tyreWear,
      compound: st.compound,
      fuel: st.fuel,
      fuelLaps,
      ers: st.ers / p.car.p.ersCapacity,
      ersDeploying: st.ersDeploying,
      tc: p.car.assists.tc,
      abs: p.car.assists.abs,
      tcActive: st.tcActive > 0,
      absActive: st.absActive > 0,
      limiter: st.limiter,
      autoGear: p.car.assists.autoGear,
      penalty: p.penalty,
      net: this.netInfo ? this.netInfo() : null,
      mapDots,
      raceTime: race && s.phase === 'racing' ? s.time - s.goTime : null,
      pit,
      brake,
    };
  }

  /** Kamera für Ergebnis-/Pausenanzeige um das Spielerauto kreisen lassen. */
  orbitCamera(dt: number, t: number): void {
    const st = this.session.player.car.st;
    this.tmpV.set(st.x, st.y, st.z);
    this.rig.orbit(dt, this.tmpV, t);
    this.trackScene.update(dt, this.renderer.camera.position);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.acc = 0;
    if (p) this.audio.silence();
    this.input.clearEdges();
  }

  /** Nächste Reifenmischung für den Boxenstopp. */
  setNextCompound(c: SessionCar['nextCompound']): void {
    this.session.player.nextCompound = c;
  }

  dispose(): void {
    this.disposed = true;
    this.input.captureGameKeys = false;
    this.audio.silence();
    this.hud.dispose();
    this.trackScene.dispose();
    this.lineView.dispose();
    this.brakeMarker.dispose();
    this.pitCrew.dispose();
    this.smoke.dispose();
    this.sparks.dispose();
    this.skids.dispose();
    this.rain?.dispose();
    this.scene.environment?.dispose();
    // Fahrzeuggeometrien/-materialien sind zwischengespeichert und werden wiederverwendet
    this.scene.clear();
  }
}

function fmtGap(g: number | null): string {
  if (g === null) return '';
  if (g < 0) return `+${-g} Rd.`;
  return `+${g.toFixed(g < 10 ? 3 : 1)}`;
}

function cameraName(m: string): string {
  return (
    {
      tv: 'TV-Kamera',
      close: 'Nah hinter dem Fahrzeug',
      far: 'Weit hinter dem Fahrzeug',
      cockpit: 'Cockpit',
      front: 'Frontkamera',
      trackside: 'Streckenkameras',
    } as Record<string, string>
  )[m] ?? m;
}
