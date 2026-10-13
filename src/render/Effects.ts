// Partikeleffekte (Reifenrauch, Funken, Schmutz, Gischt), Regen und Bremsspuren.
import * as THREE from 'three';
import { smokeTexture } from './textures';

const MAX = 2400;

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  r: number;
  g: number;
  b: number;
  a: number;
  drag: number;
  grav: number;
}

/** Partikelsystem mit einem Draw-Call (Points mit eigener Größe/Alpha pro Partikel). */
export class Particles {
  readonly points: THREE.Points;
  private parts: P[] = [];
  private readonly pos = new Float32Array(MAX * 3);
  private readonly col = new Float32Array(MAX * 4);
  private readonly size = new Float32Array(MAX);
  private readonly geo = new THREE.BufferGeometry();
  private readonly additive: boolean;

  constructor(additive = false) {
    this.additive = additive;
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: smokeTexture() }, scale: { value: 600 } },
      vertexShader: `attribute vec4 pcolor; attribute float psize; varying vec4 vC; uniform float scale;
        void main(){ vC = pcolor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = psize * scale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vC; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC.rgb, vC.a * t.a); if (gl_FragColor.a < 0.01) discard;
        #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.geo.setDrawRange(0, 0);
  }

  setScale(viewportHeight: number, fovDeg: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.scale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(p: Partial<P> & { x: number; y: number; z: number }): void {
    if (this.parts.length >= MAX) this.parts.shift();
    this.parts.push({
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0,
      max: 1,
      size: 0.5,
      grow: 1,
      r: 1,
      g: 1,
      b: 1,
      a: 0.5,
      drag: 1,
      grav: 0,
      ...p,
    });
  }

  update(dt: number): void {
    const parts = this.parts;
    let w = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr;
      p.vy = p.vy * dr - p.grav * dt;
      p.vz *= dr;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.size += p.grow * dt;
      parts[w++] = p;
    }
    parts.length = w;
    for (let i = 0; i < w; i++) {
      const p = parts[i];
      const t = p.life / p.max;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      this.col[i * 4] = p.r;
      this.col[i * 4 + 1] = p.g;
      this.col[i * 4 + 2] = p.b;
      this.col[i * 4 + 3] = p.a * (this.additive ? 1 - t : fade);
      this.size[i] = p.size;
    }
    this.geo.setDrawRange(0, w);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('pcolor') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('psize') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.parts.length = 0;
    this.geo.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Regen als Linien um die Kamera. */
export class Rain {
  readonly lines: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly count: number;
  private readonly drops: Float32Array;

  constructor(count = 2500) {
    this.count = count;
    this.pos = new Float32Array(count * 6);
    this.drops = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.drops[i * 3] = (Math.random() - 0.5) * 60;
      this.drops[i * 3 + 1] = Math.random() * 30;
      this.drops[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.45, depthWrite: false });
    this.lines = new THREE.LineSegments(g, m);
    this.lines.frustumCulled = false;
  }

  update(dt: number, cam: THREE.Vector3, vel: THREE.Vector3): void {
    const fall = 22;
    for (let i = 0; i < this.count; i++) {
      let y = this.drops[i * 3 + 1] - fall * dt;
      if (y < -4) {
        y += 34;
        this.drops[i * 3] = (Math.random() - 0.5) * 60;
        this.drops[i * 3 + 2] = (Math.random() - 0.5) * 60;
      }
      this.drops[i * 3 + 1] = y;
      const x = cam.x + this.drops[i * 3];
      const z = cam.z + this.drops[i * 3 + 2];
      const yy = cam.y + y - 8;
      // Streifen entgegen der Relativbewegung
      const sx = -vel.x * 0.03;
      const sz = -vel.z * 0.03;
      this.pos[i * 6] = x;
      this.pos[i * 6 + 1] = yy;
      this.pos[i * 6 + 2] = z;
      this.pos[i * 6 + 3] = x + sx;
      this.pos[i * 6 + 4] = yy + 0.7;
      this.pos[i * 6 + 5] = z + sz;
    }
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

/** Bremsspuren als Ringpuffer aus Quads. */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly max: number;
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private next = 0;
  private last: ({ x: number; y: number; z: number } | null)[] = [];

  constructor(max = 3000) {
    this.max = max;
    this.pos = new Float32Array(max * 4 * 3);
    this.alpha = new Float32Array(max * 4);
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) {
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.03,0.03,0.035, vA); }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
  }

  /** Spur für Rad k eines Fahrzeugs. key = carId*4+wheel. */
  add(key: number, x: number, y: number, z: number, nx: number, nz: number, width: number, strength: number): void {
    const prev = this.last[key];
    this.last[key] = { x, y, z };
    if (!prev || strength <= 0) return;
    const dx = x - prev.x;
    const dz = z - prev.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.04) {
      this.last[key] = prev;
      return;
    }
    if (d2 > 25) return;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const hw = width / 2;
    const p = this.pos;
    const o = i * 12;
    p[o] = prev.x + nx * hw;
    p[o + 1] = prev.y + 0.02;
    p[o + 2] = prev.z + nz * hw;
    p[o + 3] = prev.x - nx * hw;
    p[o + 4] = prev.y + 0.02;
    p[o + 5] = prev.z - nz * hw;
    p[o + 6] = x + nx * hw;
    p[o + 7] = y + 0.02;
    p[o + 8] = z + nz * hw;
    p[o + 9] = x - nx * hw;
    p[o + 10] = y + 0.02;
    p[o + 11] = z - nz * hw;
    const a = Math.min(0.55, strength * 0.6);
    this.alpha.fill(a, i * 4, i * 4 + 4);
    (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.mesh.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  break(key: number): void {
    this.last[key] = null;
  }

  clear(): void {
    this.alpha.fill(0);
    this.last = [];
    (this.mesh.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
