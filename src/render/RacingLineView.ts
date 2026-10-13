// Dynamische Ideallinie: grün = beschleunigen, gelb = lupfen/Kurve, rot = bremsen.
import * as THREE from 'three';
import type { RaceLineData } from '../shared/racingLine';
import type { Track } from '../shared/track';
import type { LineMode } from '../sim/config';

const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

export class RacingLineView {
  readonly mesh: THREE.Mesh;
  private readonly colors: Float32Array;
  private readonly track: Track;
  private readonly n: number;
  private lastWindow: [number, number] = [0, 0];

  constructor(track: Track, line: RaceLineData) {
    this.track = track;
    const n = track.n;
    this.n = n;
    const pos = new Float32Array((n + 1) * 2 * 3);
    this.colors = new Float32Array((n + 1) * 2 * 4);
    const idx: number[] = [];
    const w = 0.45;
    for (let k = 0; k <= n; k++) {
      const i = k % n;
      const s = i * track.spacing;
      const d = track.raceLine[i];
      track.pointAt(s, d, pt);
      const nx = pt.tz;
      const nz = -pt.tx;
      pos.set([pt.x + nx * w, pt.y + 0.03, pt.z + nz * w, pt.x - nx * w, pt.y + 0.03, pt.z - nz * w], k * 6);
      if (k < n) idx.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
    }
    void line;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Aktualisiert die Farben im Sichtfenster vor dem Spieler. */
  update(mode: LineMode, s: number, speed: number, profile: Float32Array): void {
    this.mesh.visible = mode !== 'off';
    if (mode === 'off') return;
    const tr = this.track;
    const n = this.n;
    const c = this.colors;
    // altes Fenster ausblenden
    for (let k = this.lastWindow[0]; k < this.lastWindow[1]; k++) {
      const i = ((k % n) + n) % n;
      c[i * 8 + 3] = 0;
      c[i * 8 + 7] = 0;
      if (i === 0) {
        c[n * 8 + 3] = 0;
        c[n * 8 + 7] = 0;
      }
    }
    const i0 = Math.floor(s / tr.spacing) + 2;
    const len = Math.round(260 / tr.spacing);
    for (let k = 0; k < len; k++) {
      const i = (i0 + k) % n;
      const vT = profile[i];
      const iAhead = (i + 8) % n;
      let r = 0.15;
      let g = 0.9;
      let b = 0.25;
      let important = false;
      if (speed > vT + 2.5) {
        // muss vor diesem Punkt bremsen
        r = 0.95;
        g = 0.15;
        b = 0.12;
        important = true;
      } else if (profile[iAhead] < vT - 1 || vT < 70) {
        if (vT < profile[(i + 25) % n] - 2) {
          r = 0.2;
          g = 0.9;
          b = 0.3;
        } else {
          r = 1;
          g = 0.8;
          b = 0.1;
          important = true;
        }
      }
      if (vT < 75) important = true;
      let a = 0.85 * Math.min(1, k / 6) * Math.min(1, (len - k) / 20);
      if (mode === 'corners' && !important) a = 0;
      c.set([r, g, b, a, r, g, b, a], i * 8);
      if (i === 0) c.set([r, g, b, a, r, g, b, a], n * 8);
    }
    this.lastWindow = [i0, i0 + len];
    (this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
