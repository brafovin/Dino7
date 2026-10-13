// Bremslinie: rot-weiße Markierung quer über die Fahrbahn am berechneten Bremspunkt
// (gelb bei reinem Gaswegnehmen). Folgt Höhe und Querneigung der Strecke.
import * as THREE from 'three';
import type { Track } from '../shared/track';
import type { BrakeState } from '../sim/brakeAdvice';

const SEG = 16;
/** Tiefe der Markierung in Fahrtrichtung (m) */
const DEPTH = 6;
/** Pfosten an beiden Fahrbahnrändern mit Banner darüber (aus der Ferne sichtbar) */
const POST_H = 3.4;
const BANNER_H = 0.8;
const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

function makeTexture(bg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);
  // weiße Pfeilspitze in Fahrtrichtung (oben = vorne)
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(14, 106);
  g.lineTo(64, 30);
  g.lineTo(114, 106);
  g.lineTo(88, 106);
  g.lineTo(64, 68);
  g.lineTo(40, 106);
  g.closePath();
  g.fill();
  // dunkle Kanten vorne/hinten für Kontrast auf hellem Asphalt
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, 128, 7);
  g.fillRect(0, 121, 128, 7);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makePostTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 128;
  const g = c.getContext('2d')!;
  for (let k = 0; k < 8; k++) {
    g.fillStyle = k % 2 === 0 ? '#ff1a0e' : '#ffffff';
    g.fillRect(0, k * 16, 16, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeBannerTexture(text: string, bg: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 5);
  g.fillRect(0, 59, 256, 5);
  g.font = 'italic 900 38px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class BrakeMarker {
  /** Gruppe aus Bodenmarkierung und zwei Randpfosten */
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly posts: THREE.Mesh[] = [];
  private readonly postMat: THREE.MeshBasicMaterial;
  private readonly postTex = makePostTexture();
  private readonly postGeo = new THREE.CylinderGeometry(0.24, 0.24, POST_H, 10, 1, true);
  private readonly banner: THREE.Mesh;
  private readonly bannerMat: THREE.MeshBasicMaterial;
  private readonly bannerBrake = makeBannerTexture('BREMSEN', '#e8140c');
  private readonly bannerLift = makeBannerTexture('GAS WEG', '#d99a00');
  private readonly track: Track;
  private readonly pos: Float32Array;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly texBrake = makeTexture('#e8140c');
  private readonly texLift = makeTexture('#f5b400');
  private placedAt = NaN;
  private t = 0;

  constructor(track: Track) {
    this.track = track;
    const verts = (SEG + 1) * 2;
    this.pos = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const idx: number[] = [];
    for (let k = 0; k <= SEG; k++) {
      uv.set([k * 0.5, 0, k * 0.5, 1], k * 4);
      if (k < SEG) idx.push(k * 2, k * 2 + 2, k * 2 + 1, k * 2 + 1, k * 2 + 2, k * 2 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.mat = new THREE.MeshBasicMaterial({
      map: this.texBrake,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.postGeo.translate(0, POST_H / 2, 0);
    this.postMat = new THREE.MeshBasicMaterial({ map: this.postTex, toneMapped: false, transparent: true, opacity: 0.95 });
    for (let k = 0; k < 2; k++) {
      const m = new THREE.Mesh(this.postGeo, this.postMat);
      m.frustumCulled = false;
      this.posts.push(m);
    }
    this.bannerMat = new THREE.MeshBasicMaterial({ map: this.bannerBrake, toneMapped: false, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false });
    this.banner = new THREE.Mesh(new THREE.PlaneGeometry(1, BANNER_H), this.bannerMat);
    this.banner.frustumCulled = false;
    this.group.add(this.mesh, ...this.posts, this.banner);
    this.group.visible = false;
  }

  private place(s: number): void {
    const tr = this.track;
    const hw = tr.sampleField(tr.halfW, s) + 0.4;
    const p = this.pos;
    for (let k = 0; k <= SEG; k++) {
      const d = -hw + (2 * hw * k) / SEG;
      tr.pointAt(s - DEPTH / 2, d, pt);
      p.set([pt.x, pt.y + 0.035, pt.z], k * 6);
      tr.pointAt(s + DEPTH / 2, d, pt);
      p.set([pt.x, pt.y + 0.035, pt.z], k * 6 + 3);
    }
    const geo = this.mesh.geometry;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const tiles = Math.max(2, Math.round((2 * hw) / 2));
    for (let k = 0; k <= SEG; k++) {
      uv.setX(k * 2, (k / SEG) * tiles);
      uv.setX(k * 2 + 1, (k / SEG) * tiles);
    }
    uv.needsUpdate = true;
    let yTop = -Infinity;
    for (let k = 0; k < 2; k++) {
      tr.pointAt(s, (k === 0 ? -1 : 1) * (hw + 0.6), pt);
      this.posts[k].position.set(pt.x, pt.y, pt.z);
      yTop = Math.max(yTop, pt.y + POST_H);
    }
    // Banner zwischen den Pfosten, dem anfahrenden Auto zugewandt
    tr.pointAt(s, 0, pt);
    const width = 2 * (hw + 0.6);
    this.banner.position.set(pt.x, yTop - BANNER_H / 2, pt.z);
    this.banner.rotation.set(0, Math.atan2(pt.tx, pt.tz) + Math.PI, 0);
    this.banner.scale.set(width, 1, 1);
    this.bannerBrake.repeat.x = this.bannerLift.repeat.x = Math.max(1, Math.round(width / 3.6));
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.placedAt = s;
  }

  update(dt: number, state: BrakeState | null, speed: number): void {
    this.t += dt;
    // nur zeigen, solange der Bremspunkt vor dem Auto liegt
    if (!state || state.dist < -DEPTH) {
      this.group.visible = false;
      return;
    }
    const s = state.advice.sBrake;
    if (!(Math.abs(s - this.placedAt) < 0.3)) this.place(s);
    this.group.visible = true;
    const strong = state.advice.strong;
    const map = strong ? this.texBrake : this.texLift;
    if (this.mat.map !== map) {
      this.mat.map = map;
      this.mat.needsUpdate = true;
      this.bannerMat.map = strong ? this.bannerBrake : this.bannerLift;
      this.bannerMat.needsUpdate = true;
    }
    // Je näher, desto deutlicher; kurz vor dem Punkt pulsieren
    const tLeft = state.dist / Math.max(5, speed);
    const near = tLeft < 1.2;
    const fadeIn = Math.min(1, Math.max(0.35, 1.6 - state.dist / 260));
    this.mat.opacity = near ? 0.75 + 0.25 * Math.sin(this.t * 18) : 0.9 * fadeIn;
    this.postMat.opacity = near ? this.mat.opacity : 0.95;
    this.bannerMat.opacity = near ? 0.8 + 0.2 * Math.sin(this.t * 18) : 0.92;
    this.postMat.color.set(state.advice.strong ? 0xffffff : 0xffd040);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
    this.postGeo.dispose();
    this.postMat.dispose();
    this.postTex.dispose();
    this.banner.geometry.dispose();
    this.bannerMat.dispose();
    this.bannerBrake.dispose();
    this.bannerLift.dispose();
    this.texBrake.dispose();
    this.texLift.dispose();
  }
}
