// Kamerasystem: Verfolger-, Cockpit-, Front- und Streckenkameras mit Dämpfung.
import * as THREE from 'three';
import type { CarState } from '../shared/carPhysics';
import { clamp, damp, wrapAngle } from '../shared/math';
import type { Projection, Track } from '../shared/track';
import type { CameraMode } from '../settings';

const tmpProj: Projection = { i: 0, s: 0, d: 0, y: 0, tx: 0, tz: 1, dist2: 0 };
const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

interface ChaseDef {
  dist: number;
  height: number;
  look: number;
  lookH: number;
}

const CHASE: Record<string, ChaseDef> = {
  tv: { dist: 7.6, height: 2.35, look: 4, lookH: 0.9 },
  close: { dist: 5.0, height: 1.55, look: 5, lookH: 0.8 },
  far: { dist: 11.5, height: 3.8, look: 3, lookH: 1.0 },
};

export class CameraRig {
  mode: CameraMode = 'tv';
  baseFov = 62;
  shakeEnabled = true;
  private readonly cam: THREE.PerspectiveCamera;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private yaw = 0;
  private initialized = false;
  private shake = 0;
  private trackHint = -1;
  private tsCams: { s: number; x: number; y: number; z: number }[] = [];
  private tsIndex = -1;
  private fov = 62;
  private track: Track | null = null;
  /** Zusätzliche Erschütterung (Aufprall), klingt ab */
  bump = 0;

  constructor(cam: THREE.PerspectiveCamera) {
    this.cam = cam;
  }

  setTrack(track: Track, terrainHeight: (x: number, z: number) => number): void {
    this.track = track;
    this.tsCams = [];
    const step = 220;
    for (let s = 40; s < track.length; s += step) {
      const i = track.indexAt(s);
      const side = track.curv[i] > 0 ? -1 : 1;
      const bar = side > 0 ? track.barL[i] : track.barR[i];
      track.pointAt(s, side * (bar + 6), pt);
      const y = Math.max(pt.y, terrainHeight(pt.x, pt.z)) + 5.5;
      this.tsCams.push({ s, x: pt.x, y, z: pt.z });
    }
    this.initialized = false;
  }

  reset(): void {
    this.initialized = false;
  }

  /** Nächsten Modus wählen. */
  cycle(): CameraMode {
    const order: CameraMode[] = ['tv', 'close', 'far', 'cockpit', 'front', 'trackside'];
    this.mode = order[(order.indexOf(this.mode) + 1) % order.length];
    this.initialized = false;
    return this.mode;
  }

  update(dt: number, st: CarState, lookBack: boolean, curbShake: number): void {
    const cam = this.cam;
    const fwdX = Math.sin(st.heading);
    const fwdZ = Math.cos(st.heading);
    const speed = Math.max(0, st.vx);
    let targetFov = this.baseFov;
    this.shake = this.shakeEnabled ? Math.max(curbShake * 0.6, this.shake * Math.exp(-6 * dt)) : 0;
    this.bump = Math.max(0, this.bump - dt * 3);
    const sh = this.shakeEnabled ? this.shake * 0.04 + this.bump * 0.12 : 0;
    const rx = (Math.random() - 0.5) * sh;
    const ry = (Math.random() - 0.5) * sh;

    if (this.mode === 'cockpit' || this.mode === 'front') {
      const local = this.mode === 'cockpit' ? new THREE.Vector3(0, 0.99, -0.02) : new THREE.Vector3(0, 0.62, 2.35);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-(st.pitch + st.bodyPitch) * 0.8, st.heading + (lookBack ? Math.PI : 0), (st.roll + st.bodyRoll) * 0.8, 'YXZ'));
      const p = local.clone().applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(-st.pitch, st.heading, st.roll, 'YXZ')));
      cam.position.set(st.x + p.x + rx, st.y + p.y + ry + st.bump * 0.01 * Math.sin(performance.now() * 0.08), st.z + p.z);
      // Kamera schaut entlang -Z: um 180° drehen, damit sie nach vorne (+Z) blickt
      const flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
      cam.quaternion.copy(q).multiply(flip);
      targetFov = this.baseFov + (this.mode === 'cockpit' ? 4 : 0) + clamp(speed / 90, 0, 1) * 8;
      this.initialized = false;
    } else if (this.mode === 'trackside' && this.tsCams.length && !lookBack) {
      const tr = this.track!;
      // Kamera wählen, die gerade vor/neben dem Auto liegt
      let best = -1;
      let bestScore = Infinity;
      this.tsCams.forEach((c, k) => {
        const ds = tr.deltaS(st.s, c.s);
        if (ds < -120 || ds > 160) return;
        const score = Math.abs(ds - 30) + (k === this.tsIndex ? -40 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = k;
        }
      });
      if (best < 0) {
        this.mode = 'tv';
        return this.update(dt, st, lookBack, curbShake);
      }
      this.tsIndex = best;
      const c = this.tsCams[best];
      cam.position.set(c.x, c.y, c.z);
      this.look.set(st.x + fwdX * 2, st.y + 0.6, st.z + fwdZ * 2);
      cam.lookAt(this.look);
      const dist = Math.hypot(c.x - st.x, c.z - st.z);
      targetFov = clamp((2 * Math.atan(9 / Math.max(1, dist)) * 180) / Math.PI, 12, 70);
      this.fov = targetFov;
      this.initialized = false;
    } else {
      const def = CHASE[this.mode] ?? CHASE.tv;
      // Gierwinkel mit Verzögerung; bei Drift teilweise in Bewegungsrichtung
      const velHeading = speed > 5 ? Math.atan2(st.vx * fwdX + st.vy * Math.cos(st.heading), st.vx * fwdZ - st.vy * Math.sin(st.heading)) : st.heading;
      const desiredYaw = st.heading + wrapAngle(velHeading - st.heading) * 0.35 + (lookBack ? Math.PI : 0);
      // Nach Reset/Teleport sofort springen statt quer durch die Szenerie zu fahren
      if (this.initialized && Math.hypot(this.pos.x - st.x, this.pos.z - st.z) > 35) this.initialized = false;
      if (!this.initialized) this.yaw = desiredYaw;
      this.yaw += wrapAngle(desiredYaw - this.yaw) * Math.min(1, (lookBack ? 30 : 7) * dt);
      const bx = Math.sin(this.yaw);
      const bz = Math.cos(this.yaw);
      const dist = def.dist + clamp(speed / 90, 0, 1) * 0.6;
      const desired = new THREE.Vector3(st.x - bx * dist, st.y + def.height, st.z - bz * dist);
      // Nicht durch Barrieren oder unter die Fahrbahn
      if (this.track) {
        const tr = this.track;
        tr.project(desired.x, desired.z, this.trackHint >= 0 ? this.trackHint : st.trackIdx, tmpProj);
        this.trackHint = tmpProj.i;
        const bar = tmpProj.d > 0 ? tr.barrierAt(tmpProj.s, true) : tr.barrierAt(tmpProj.s, false);
        const maxD = bar - 0.6;
        if (Math.abs(tmpProj.d) > maxD && Math.abs(st.d) < bar) {
          tr.pointAt(tmpProj.s, Math.sign(tmpProj.d) * maxD, pt);
          desired.x = pt.x;
          desired.z = pt.z;
        }
        const ground = tr.heightAt(tmpProj.s, clamp(tmpProj.d, -bar, bar));
        desired.y = Math.max(desired.y, ground + 0.7);
      }
      if (!this.initialized) {
        this.pos.copy(desired);
        this.look.set(st.x, st.y + def.lookH, st.z);
        this.initialized = true;
      }
      const k = 1 - Math.exp(-14 * dt);
      this.pos.lerp(desired, k);
      // Höhe etwas weicher, damit Kuppen nicht ruckeln
      const lookTarget = new THREE.Vector3(st.x + bx * def.look, st.y + def.lookH, st.z + bz * def.look);
      this.look.lerp(lookTarget, 1 - Math.exp(-20 * dt));
      cam.position.set(this.pos.x + rx, this.pos.y + ry, this.pos.z);
      cam.lookAt(this.look);
      targetFov = this.baseFov + clamp(speed / 95, 0, 1) * 9;
    }
    if (this.mode !== 'trackside') this.fov = damp(this.fov, targetFov, 4, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }

  /** Freie Orbit-Kamera (Ergebnis/Wiederholung). */
  orbit(dt: number, target: THREE.Vector3, t: number, radius = 9, height = 2.6): void {
    const a = t * 0.25;
    this.cam.position.set(target.x + Math.sin(a) * radius, target.y + height, target.z + Math.cos(a) * radius);
    this.cam.lookAt(target.x, target.y + 0.5, target.z);
    void dt;
    this.initialized = false;
  }
}
