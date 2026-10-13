// Boxencrews aller Teams (instanziert) und Ampel an der Boxenausfahrt.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TEAMS } from '../shared/teams';
import type { Track } from '../shared/track';

const CREW = 11;
// Arbeitspositionen im Fahrzeugsystem (vorwärts, links): Wagenheber, Schlagschrauber, Reifenträger, Freigabe
const WORK: [number, number, boolean][] = [
  [3.6, 0, false],
  [-3.2, 0, false],
  [1.98, 1.35, true],
  [1.98, -1.35, true],
  [-1.62, 1.35, true],
  [-1.62, -1.35, true],
  [2.5, 2.0, false],
  [2.5, -2.0, false],
  [-1.0, 2.0, false],
  [-1.0, -2.0, false],
  [4.8, 1.6, false],
];

export interface PitCarInfo {
  teamIndex: number;
  /** Auto ist auf dem Weg zur Box oder steht darin */
  incoming: boolean;
  stopped: boolean;
}

const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

/** Mechaniker-Silhouette (Beine, Rumpf, Arme) mit Helligkeit als Vertexfarbe; Teamfarbe kommt pro Instanz. */
function crewBodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, shade: number, x: number, y: number, z: number, rx = 0) => {
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    const n = g.getAttribute('position').count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(shade), 3));
    parts.push(g);
  };
  add(new THREE.BoxGeometry(0.17, 0.8, 0.22), 0.55, -0.12, 0.4, 0);
  add(new THREE.BoxGeometry(0.17, 0.8, 0.22), 0.55, 0.12, 0.4, 0);
  add(new THREE.BoxGeometry(0.2, 0.08, 0.3), 0.15, -0.12, 0.04, 0.04);
  add(new THREE.BoxGeometry(0.2, 0.08, 0.3), 0.15, 0.12, 0.04, 0.04);
  add(new THREE.BoxGeometry(0.46, 0.62, 0.28), 1, 0, 1.1, 0);
  add(new THREE.BoxGeometry(0.12, 0.58, 0.13), 0.8, -0.3, 1.04, 0.1, -0.35);
  add(new THREE.BoxGeometry(0.12, 0.58, 0.13), 0.8, 0.3, 1.04, 0.1, -0.35);
  add(new THREE.BoxGeometry(0.12, 0.1, 0.12), 0.2, 0, 1.45, 0);
  const g = mergeGeometries(parts)!;
  for (const x of parts) x.dispose();
  return g;
}

export class PitCrew {
  readonly group = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh;
  private readonly heads: THREE.InstancedMesh;
  private readonly cur: Float32Array;
  private readonly boxFrames: { x: number; y: number; z: number; fx: number; fz: number; lx: number; lz: number; heading: number }[] = [];
  private readonly rest: [number, number][] = [];
  private readonly track: Track;
  private readonly lightRed: THREE.MeshStandardMaterial;
  private readonly lightGreen: THREE.MeshStandardMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly lean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.45);
  private readonly disposables: { dispose(): void }[] = [];

  constructor(track: Track) {
    this.track = track;
    const pit = track.pit;
    const side = pit.side;
    const nBox = pit.boxes.length;
    for (let b = 0; b < nBox; b++) {
      track.pointAt(pit.boxes[b], side * pit.boxLane, pt);
      this.boxFrames.push({ x: pt.x, y: pt.y, z: pt.z, fx: pt.tx, fz: pt.tz, lx: pt.tz, lz: -pt.tx, heading: Math.atan2(pt.tx, pt.tz) });
    }
    // Wartepositionen vor der Garage (Reihe entlang der Boxengasse)
    const towardGarage = side * (pit.outerD - pit.boxLane - 1.4);
    for (let k = 0; k < CREW; k++) this.rest.push([-5 + k * 1.0, towardGarage]);
    const total = nBox * CREW;
    const bodyGeo = crewBodyGeometry();
    const headGeo = new THREE.SphereGeometry(0.17, 12, 9);
    headGeo.scale(1, 1.05, 1.12);
    headGeo.translate(0, 1.64, 0.02);
    const bodyMat = new THREE.MeshStandardMaterial({ roughness: 0.75, vertexColors: true });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.3, metalness: 0.2 });
    this.bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, total);
    this.heads = new THREE.InstancedMesh(headGeo, headMat, total);
    this.bodies.castShadow = true;
    this.cur = new Float32Array(total * 2);
    const col = new THREE.Color();
    for (let b = 0; b < nBox; b++) {
      const team = TEAMS[b % TEAMS.length];
      for (let k = 0; k < CREW; k++) {
        const i = b * CREW + k;
        this.cur[i * 2] = this.rest[k][0];
        this.cur[i * 2 + 1] = this.rest[k][1];
        col.set(k % 3 === 0 ? team.livery.secondary : team.livery.primary);
        this.bodies.setColorAt(i, col);
      }
    }
    this.group.add(this.bodies, this.heads);
    this.disposables.push(bodyGeo, headGeo, bodyMat, headMat);
    // Ampel an der Boxenausfahrt
    this.lightRed = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1a1a, emissiveIntensity: 0 });
    this.lightGreen = new THREE.MeshStandardMaterial({ color: 0x003300, emissive: 0x19ff5a, emissiveIntensity: 3 });
    const sLight = track.wrapS(pit.sWallEnd + 6);
    track.pointAt(sLight, side * (pit.wallD + 0.4), pt);
    const g = new THREE.Group();
    g.position.set(pt.x, pt.y, pt.z);
    g.rotation.y = Math.atan2(pt.tx, pt.tz) + Math.PI;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0x2a2d33, metalness: 0.6, roughness: 0.4 }));
    pole.position.y = 1.3;
    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.25), new THREE.MeshStandardMaterial({ color: 0x111111 }));
    housing.position.y = 2.75;
    const red = new THREE.Mesh(new THREE.CircleGeometry(0.13, 16), this.lightRed);
    red.position.set(0, 2.93, 0.13);
    const green = new THREE.Mesh(new THREE.CircleGeometry(0.13, 16), this.lightGreen);
    green.position.set(0, 2.58, 0.13);
    g.add(pole, housing, red, green);
    this.group.add(g);
    this.disposables.push(this.lightRed, this.lightGreen);
    this.update(0, [], true);
  }

  /** Aktualisiert Crew-Positionen und Ausfahrtsampel. */
  update(dt: number, cars: PitCarInfo[], exitOpen: boolean): void {
    const nBox = this.boxFrames.length;
    this.lightRed.emissiveIntensity = exitOpen ? 0 : 5;
    this.lightGreen.emissiveIntensity = exitOpen ? 3 : 0;
    const step = Math.min(1, dt * 5);
    for (let b = 0; b < nBox; b++) {
      const info = cars.filter((c) => c.teamIndex % nBox === b);
      const working = info.some((c) => c.incoming || c.stopped);
      const stopped = info.some((c) => c.stopped);
      const f = this.boxFrames[b];
      for (let k = 0; k < CREW; k++) {
        const i = b * CREW + k;
        const [tf, tl] = working ? [WORK[k][0], WORK[k][1]] : this.rest[k];
        this.cur[i * 2] += (tf - this.cur[i * 2]) * step;
        this.cur[i * 2 + 1] += (tl - this.cur[i * 2 + 1]) * step;
        const lf = this.cur[i * 2];
        const ll = this.cur[i * 2 + 1];
        const x = f.x + f.fx * lf + f.lx * ll;
        const z = f.z + f.fz * lf + f.lz * ll;
        // Blickrichtung: arbeitend zum Auto, wartend zur Boxengasse
        const yaw = working ? Math.atan2(f.x - x, f.z - z) : f.heading + (this.track.pit.side > 0 ? -Math.PI / 2 : Math.PI / 2);
        const crouch = stopped && WORK[k][2];
        this.q.setFromAxisAngle(this.up, yaw);
        if (crouch) this.q.multiply(this.lean);
        this.v.set(x, f.y, z);
        this.sc.set(1, crouch ? 0.72 : 1, 1);
        this.m.compose(this.v, this.q, this.sc);
        this.bodies.setMatrixAt(i, this.m);
        this.heads.setMatrixAt(i, this.m);
      }
    }
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }
}
