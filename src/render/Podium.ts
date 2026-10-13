// Siegerehrung: Podest (2 – 1 – 3) mit Fahrerfiguren in Teamfarben, Pokalen, Champagner,
// Konfetti, Feuerwerk und den drei Autos davor. Eigene Szene, Kamerafahrt im Zeitablauf.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Driver, Team } from '../shared/teams';
import { buildCar } from './CarModel';
import { DriverFigure } from './DriverFigure';
import type { Renderer } from './Renderer';

export interface PodiumEntry {
  position: 1 | 2 | 3;
  driver: Driver;
  team: Team;
}

/** Ablauf (Sekunden): Einzug der Kamera, Pokale, danach Champagner */
const T_TROPHY = 1.2;
const T_CHAMPAGNE = 7.5;

const STEP = {
  1: { x: 0, h: 1.3 },
  2: { x: -2.35, h: 0.95 },
  3: { x: 2.35, h: 0.65 },
} as const;
const STEP_W = 2.2;
const STEP_D = 2.0;
const METAL = { 1: 0xffc93c, 2: 0xd9dee6, 3: 0xc77c3a } as const;

// ------------------------------------------------------------------ Hilfsfunktionen

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function trophy(pos: 1 | 2 | 3): THREE.Group {
  const g = new THREE.Group();
  const s = pos === 1 ? 1 : 0.85;
  const mat = new THREE.MeshStandardMaterial({ color: METAL[pos], metalness: 1, roughness: 0.22 });
  const prof = [
    [0.0, 0],
    [0.09, 0],
    [0.09, 0.03],
    [0.035, 0.05],
    [0.025, 0.16],
    [0.05, 0.19],
    [0.12, 0.28],
    [0.14, 0.4],
    [0.13, 0.42],
  ].map(([x, y]) => new THREE.Vector2(x * s, y * s));
  const cup = new THREE.Mesh(new THREE.LatheGeometry(prof, 24), mat);
  g.add(cup);
  for (const side of [-1, 1]) {
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.055 * s, 0.012 * s, 6, 14, Math.PI), mat);
    handle.position.set(side * 0.14 * s, 0.32 * s, 0);
    handle.rotation.z = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(handle);
  }
  g.traverse((o) => ((o as THREE.Mesh).castShadow = true));
  return g;
}

function bottle(): THREE.Group {
  const g = new THREE.Group();
  const glass = new THREE.MeshStandardMaterial({ color: 0x0f3a1c, metalness: 0.2, roughness: 0.15 });
  const foil = new THREE.MeshStandardMaterial({ color: 0xd8b24a, metalness: 0.9, roughness: 0.3 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 12), glass);
  body.position.y = 0.11;
  const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.045, 0.07, 12), glass);
  shoulder.position.y = 0.255;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.08, 10), foil);
  neck.position.y = 0.33;
  g.add(body, shoulder, neck);
  return g;
}

// ------------------------------------------------------------------ Partikel

let dotTexture: THREE.CanvasTexture | null = null;
/** weicher, runder Punkt für Partikel */
function dot(): THREE.CanvasTexture {
  if (!dotTexture) {
    dotTexture = canvasTexture(32, 32, (g) => {
      const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.45, 'rgba(255,255,255,0.85)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 32, 32);
    });
  }
  return dotTexture;
}

class PointPool {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly base: Float32Array;
  private next = 0;
  private readonly n: number;
  private readonly drag: number;
  private readonly gravity: number;

  constructor(n: number, size: number, additive: boolean, gravity: number, drag: number) {
    this.n = n;
    this.gravity = gravity;
    this.drag = drag;
    this.pos = new Float32Array(n * 3).fill(-999);
    this.col = new Float32Array(n * 3);
    this.base = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n * 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({
      size,
      map: dot(),
      alphaTest: 0.02,
      vertexColors: true,
      transparent: true,
      opacity: additive ? 1 : 0.85,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: THREE.Color): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.base.set([color.r, color.g, color.b], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.life[i * 2] = life;
    this.life[i * 2 + 1] = life;
  }

  update(dt: number): void {
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i * 2] <= 0) continue;
      this.life[i * 2] -= dt;
      const j = i * 3;
      if (this.life[i * 2] <= 0) {
        this.pos[j + 1] = -999;
        continue;
      }
      this.vel[j] *= k;
      this.vel[j + 1] = this.vel[j + 1] * k - this.gravity * dt;
      this.vel[j + 2] *= k;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      const f = Math.min(1, (this.life[i * 2] / this.life[i * 2 + 1]) * 1.6);
      this.col[j] = this.base[j] * f;
      this.col[j + 1] = this.base[j + 1] * f;
      this.col[j + 2] = this.base[j + 2] * f;
    }
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------------ Szene

export class PodiumScene {
  readonly scene = new THREE.Scene();
  /** stage: 0 = wartet, 1 = Pokal, 2 = Champagner */
  private readonly figures: { fig: DriverFigure; pos: 1 | 2 | 3; trophy: THREE.Group; bottle: THREE.Group; top: number; stage: number }[] = [];
  private readonly confetti: THREE.InstancedMesh;
  private readonly confState: Float32Array;
  private readonly spray = new PointPool(2600, 0.05, false, 7, 0.6);
  private readonly fireworks = new PointPool(1600, 0.32, true, 2.2, 1.1);
  private readonly spots: THREE.SpotLight[] = [];
  private readonly envRT: THREE.WebGLRenderTarget | null = null;
  private t = 0;
  private nextFirework = 0.6;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly sc = new THREE.Vector3(1, 1, 1);
  private readonly tmpColor = new THREE.Color();
  private readonly palette: THREE.Color[];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(renderer: Renderer, entries: PodiumEntry[], trackName: string) {
    const s = this.scene;
    // Abendhimmel
    const sky = canvasTexture(16, 256, (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, '#060a1c');
      gr.addColorStop(0.55, '#1a2350');
      gr.addColorStop(0.8, '#7a3a4a');
      gr.addColorStop(1, '#e0844a');
      g.fillStyle = gr;
      g.fillRect(0, 0, 16, 256);
    });
    s.background = sky;
    s.fog = new THREE.Fog('#141a36', 30, 80);
    this.disposables.push(sky);
    try {
      const pmrem = new THREE.PMREMGenerator(renderer.gl);
      this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      s.environment = this.envRT.texture;
      s.environmentIntensity = 0.5;
      pmrem.dispose();
    } catch {
      /* optional */
    }
    this.palette = ['#ffd23c', '#ffffff', '#e8002d', '#2fa4ff', '#5cff7a', ...entries.map((e) => e.team.livery.primary)].map((c) => new THREE.Color(c));

    // Boden und Bühne
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x1b1e25, roughness: 0.85 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    const stageMat = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.4, metalness: 0.3 });
    const stage = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.25, 4.2), stageMat);
    stage.position.set(0, 0.125, -0.3);
    stage.receiveShadow = true;
    const carpetMat = new THREE.MeshStandardMaterial({ color: 0xb3081f, roughness: 0.9 });
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 6), carpetMat);
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(0, 0.01, 4.6);
    s.add(floor, stage, carpet);
    this.disposables.push(floor.geometry, floorMat, stage.geometry, stageMat, carpet.geometry, carpetMat);

    // Rückwand mit Schriftzug
    const wallTex = canvasTexture(1024, 384, (g) => {
      const gr = g.createLinearGradient(0, 0, 0, 384);
      gr.addColorStop(0, '#10131a');
      gr.addColorStop(1, '#1d2230');
      g.fillStyle = gr;
      g.fillRect(0, 0, 1024, 384);
      for (let x = 0; x < 1024; x += 32) {
        for (let y = 0; y < 2; y++) {
          g.fillStyle = (x / 32 + y) % 2 === 0 ? '#ffffff' : '#0a0a0a';
          g.fillRect(x, 330 + y * 16, 32, 16);
        }
      }
      g.fillStyle = '#e8002d';
      g.fillRect(0, 0, 1024, 10);
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = 'italic 900 120px system-ui, sans-serif';
      g.fillText('APEX GP', 512, 150);
      g.font = '700 46px system-ui, sans-serif';
      g.fillStyle = '#c9d2e3';
      g.fillText(trackName.toUpperCase(), 512, 230);
      g.font = '600 30px system-ui, sans-serif';
      g.fillStyle = '#ffcf40';
      g.fillText('SIEGEREHRUNG', 512, 290);
    });
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: wallTex, emissiveIntensity: 0.35 });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(16, 6), wallMat);
    wall.position.set(0, 4.6, -3.0);
    s.add(wall);
    this.disposables.push(wallTex, wallMat, wall.geometry);
    // Lichtsäulen
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xe8002d, toneMapped: false });
    const ledGeo = new THREE.BoxGeometry(0.12, 7.6, 0.12);
    for (const x of [-8.2, 8.2]) {
      const led = new THREE.Mesh(ledGeo, ledMat);
      led.position.set(x, 3.8, -2.9);
      s.add(led);
    }
    this.disposables.push(ledMat, ledGeo);

    // Podeststufen
    const stepMat = new THREE.MeshStandardMaterial({ color: 0xf2f3f5, roughness: 0.35, metalness: 0.05 });
    this.disposables.push(stepMat);
    for (const pos of [1, 2, 3] as const) {
      const st = STEP[pos];
      const box = new THREE.Mesh(new THREE.BoxGeometry(STEP_W, st.h, STEP_D), stepMat);
      box.position.set(st.x, 0.25 + st.h / 2, 0);
      box.castShadow = true;
      box.receiveShadow = true;
      const trimMat = new THREE.MeshStandardMaterial({ color: METAL[pos], metalness: 0.9, roughness: 0.3 });
      const trim = new THREE.Mesh(new THREE.BoxGeometry(STEP_W + 0.02, 0.07, STEP_D + 0.02), trimMat);
      trim.position.set(st.x, 0.25 + st.h - 0.035, 0);
      const numTex = canvasTexture(256, 256, (g) => {
        g.fillStyle = '#f2f3f5';
        g.fillRect(0, 0, 256, 256);
        g.fillStyle = '#' + new THREE.Color(METAL[pos]).getHexString();
        g.font = 'italic 900 200px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(pos), 128, 140);
      });
      const numMat = new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.4 });
      const sz = Math.min(0.9, st.h * 0.85);
      const num = new THREE.Mesh(new THREE.PlaneGeometry(sz, sz), numMat);
      num.position.set(st.x, 0.25 + st.h / 2, STEP_D / 2 + 0.005);
      s.add(box, trim, num);
      this.disposables.push(box.geometry, trim.geometry, trimMat, numTex, numMat, num.geometry);
      // Spot je Stufe
      const sp = new THREE.SpotLight(pos === 1 ? 0xfff0c0 : 0xffffff, pos === 1 ? 140 : 90, 26, 0.32, 0.5, 1.4);
      sp.position.set(st.x * 1.4, 10, 7);
      sp.target.position.set(st.x, 1.5, 0);
      s.add(sp, sp.target);
      this.spots.push(sp);
    }

    // Fahrer, Pokale und Autos
    for (const e of entries) {
      const st = STEP[e.position];
      const fig = new DriverFigure(e.team, e.driver);
      const top = 0.25 + st.h;
      fig.root.position.set(st.x, top, 0.1);
      const tr = trophy(e.position);
      const bt = bottle();
      for (const o of [tr, bt])
        o.traverse((x) => {
          const mesh = x as THREE.Mesh;
          if (mesh.isMesh) this.disposables.push(mesh.geometry, mesh.material as THREE.Material);
        });
      bt.visible = false;
      s.add(fig.root);
      this.figures.push({ fig, pos: e.position, trophy: tr, bottle: bt, top, stage: 0 });
      // Auto im Vordergrund
      const car = buildCar(e.team, e.driver, 2);
      const cx = e.position === 1 ? 0 : e.position === 2 ? -4.4 : 4.4;
      car.root.position.set(cx, 0, e.position === 1 ? 5.4 : 4.6);
      car.root.rotation.y = e.position === 1 ? 0 : e.position === 2 ? 0.55 : -0.55;
      car.root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
      });
      s.add(car.root);
    }

    // Licht
    s.add(new THREE.HemisphereLight(0x9fb2e6, 0x1a1410, 0.55));
    const key = new THREE.DirectionalLight(0xffe2c0, 1.6);
    key.position.set(6, 12, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -9, right: 9, top: 8, bottom: -4, near: 1, far: 40 });
    key.shadow.bias = -0.0004;
    s.add(key);

    // Konfetti
    const CONF = 700;
    const confGeo = new THREE.PlaneGeometry(0.07, 0.11);
    const confMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
    this.confetti = new THREE.InstancedMesh(confGeo, confMat, CONF);
    this.confetti.frustumCulled = false;
    this.confState = new Float32Array(CONF * 8); // x y z vy rx ry spin phase
    for (let i = 0; i < CONF; i++) {
      this.resetConfetti(i, true);
      this.confetti.setColorAt(i, this.palette[i % this.palette.length]);
    }
    this.confetti.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    s.add(this.confetti, this.spray.points, this.fireworks.points);
    this.disposables.push(confGeo, confMat, this.spray, this.fireworks);
    this.update(0, renderer.camera, renderer.camera.aspect);
  }

  private resetConfetti(i: number, initial: boolean): void {
    const c = this.confState;
    const j = i * 8;
    c[j] = (Math.random() - 0.5) * 16;
    c[j + 1] = initial ? 14 + Math.random() * 16 : 10 + Math.random() * 3;
    c[j + 2] = -2.5 + Math.random() * 9;
    c[j + 3] = -(0.7 + Math.random() * 0.8);
    c[j + 4] = Math.random() * 6;
    c[j + 5] = Math.random() * 6;
    c[j + 6] = 2 + Math.random() * 6;
    c[j + 7] = Math.random() * 6;
  }

  update(dt: number, cam: THREE.PerspectiveCamera, aspect: number): void {
    this.t += dt;
    const t = this.t;

    // Kamerafahrt: Totale mit Autos und Podest → Heranfahren an die Fahrer → langsames Schwenken
    const smooth = (a: number, b: number) => {
      const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
      return x * x * (3 - 2 * x);
    };
    const a1 = smooth(0, 3.2);
    const a2 = smooth(T_TROPHY + 0.8, T_CHAMPAGNE);
    const back = Math.max(1, 1.5 / Math.max(0.5, aspect));
    const dist = (20 - 4.5 * a1 - 5 * a2) * back;
    const sway = Math.sin(t * 0.22) * (1.2 + 2.2 * a2);
    cam.position.set(sway, 2.7 + 0.5 * a1 + 0.3 * a2 + Math.sin(t * 0.3) * 0.15, dist);
    cam.lookAt(sway * 0.15, 2.0 + 0.55 * a2, 0);
    if (cam.fov !== 45) {
      cam.fov = 45;
      cam.updateProjectionMatrix();
    }

    // Fahrerposen
    for (const f of this.figures) {
      const { fig, pos } = f;
      const ph = pos * 1.7;
      fig.root.position.y = f.top;
      // Gewicht verlagern, Kopf schaut ins Publikum
      const shift = Math.sin(t * 0.9 + ph);
      fig.setLegs(0.06 + Math.max(0, shift) * 0.08, 0.06 + Math.max(0, -shift) * 0.08);
      fig.torso.rotation.set(0, Math.sin(t * 0.5 + ph) * 0.08, shift * 0.025);
      fig.head.rotation.set(0, Math.sin(t * 0.7 + ph) * 0.3, 0);
      if (t < T_TROPHY) {
        fig.setArm(fig.armL, 0.12, 0.05, 0.25);
        fig.setArm(fig.armR, 0.12, 0.05, 0.25);
      } else if (t < T_CHAMPAGNE) {
        if (f.stage === 0) {
          f.stage = 1;
          fig.root.add(f.trophy);
        }
        if (pos === 1) {
          // Pokal mit beiden Händen über den Kopf stemmen
          const lift = Math.min(1, (t - T_TROPHY) / 0.9);
          const e = lift * lift * (3 - 2 * lift);
          const up = 0.12 + e * (Math.PI + 0.12);
          const pump = Math.max(0, Math.sin((t - T_TROPHY) * 3.2)) * 0.12 * e;
          fig.setArm(fig.armL, up, 0, 0.25 + e * 0.35 - pump);
          fig.setArm(fig.armR, up, 0, 0.25 + e * 0.35 - pump);
          fig.head.rotation.x = -0.3 * e;
          fig.root.updateMatrixWorld(true);
          fig.armL.hand.getWorldPosition(this.v);
          fig.armR.hand.getWorldPosition(this.v2);
          this.v.add(this.v2).multiplyScalar(0.5);
          fig.root.worldToLocal(this.v);
          f.trophy.position.set(this.v.x, this.v.y - 0.03, this.v.z);
          f.trophy.rotation.set(0, Math.sin(t * 1.2) * 0.3, 0);
        } else {
          // Pokal vor der Brust, freie Hand winkt
          fig.setArm(fig.armR, 0.08, 0.38, 1.35);
          fig.setArm(fig.armL, 2.35 + Math.sin(t * 2 + ph) * 0.1, 0, 0.45 + Math.sin(t * 7 + ph) * 0.35);
          fig.root.updateMatrixWorld(true);
          fig.armR.hand.getWorldPosition(this.v);
          fig.root.worldToLocal(this.v);
          f.trophy.position.set(this.v.x - 0.02, this.v.y - 0.02, this.v.z);
          f.trophy.rotation.set(0, 0, 0);
        }
      } else {
        // Champagner: Pokal steht auf dem Podest, Flasche nach vorne oben, freie Faust jubelt
        if (f.stage < 2) {
          // auch bei einem Zeitsprung (Ruckler) direkt aus der Warte- in die Champagnerphase
          f.stage = 2;
          f.trophy.removeFromParent();
          f.trophy.position.set(fig.root.position.x + 0.62, f.top, 0.55);
          f.trophy.rotation.set(0, 0, 0);
          this.scene.add(f.trophy);
          fig.armR.hand.add(f.bottle);
          f.bottle.visible = true;
          f.bottle.position.set(0, 0.02, 0.0);
          f.bottle.rotation.set(Math.PI, 0, 0);
        }
        const wave = Math.sin(t * 4 + ph);
        fig.setArm(fig.armR, 0.3 + wave * 0.12, 1.85 + wave * 0.25, 0.3);
        fig.setArm(fig.armL, 2.55, -0.15, 0.7 + Math.sin(t * 5 + ph) * 0.45);
        fig.torso.rotation.x = -0.07;
      }
    }

    // Champagner-Fontänen aus den Flaschenhälsen
    if (t >= T_CHAMPAGNE + 0.3 && dt > 0) {
      for (const f of this.figures) {
        if (f.stage < 2) continue;
        f.bottle.updateMatrixWorld(true);
        this.v.set(0, 0.38, 0).applyMatrix4(f.bottle.matrixWorld);
        const dir = this.dir.set(0, 1, 0).transformDirection(f.bottle.matrixWorld);
        const count = Math.round(dt * 260);
        for (let k = 0; k < count; k++) {
          const sp = 5.5 + Math.random() * 2.5;
          this.tmpColor.setRGB(1, 0.95, 0.75 + Math.random() * 0.2);
          this.spray.emit(
            this.v.x,
            this.v.y,
            this.v.z,
            dir.x * sp + (Math.random() - 0.5) * 1.4,
            dir.y * sp + (Math.random() - 0.5) * 1.4,
            dir.z * sp + (Math.random() - 0.5) * 1.4,
            1.1 + Math.random() * 0.5,
            this.tmpColor,
          );
        }
      }
    }
    this.spray.update(dt);

    // Feuerwerk hinter der Rückwand
    this.nextFirework -= dt;
    if (this.nextFirework <= 0 && dt > 0) {
      this.nextFirework = 0.55 + Math.random() * 0.8;
      const col = this.palette[Math.floor(Math.random() * this.palette.length)];
      const cx = (Math.random() - 0.5) * 26;
      const cy = 10 + Math.random() * 6;
      const cz = -10 - Math.random() * 6;
      for (let k = 0; k < 110; k++) {
        const a = Math.random() * Math.PI * 2;
        const b = Math.acos(2 * Math.random() - 1);
        const sp = 5 + Math.random() * 1.5;
        this.fireworks.emit(cx, cy, cz, Math.sin(b) * Math.cos(a) * sp, Math.cos(b) * sp, Math.sin(b) * Math.sin(a) * sp, 1.4 + Math.random() * 0.6, col);
      }
    }
    this.fireworks.update(dt);

    // Konfetti (ab dem Pokal-Moment)
    const c = this.confState;
    const active = t > T_TROPHY - 0.2;
    for (let i = 0; i < this.confetti.count; i++) {
      const j = i * 8;
      if (active) {
        c[j + 1] += c[j + 3] * dt;
        c[j] += Math.sin(t * 1.5 + c[j + 7]) * 0.35 * dt;
        c[j + 4] += c[j + 6] * dt;
        c[j + 5] += c[j + 6] * 0.7 * dt;
        if (c[j + 1] < 0.02) {
          if (t < 25) this.resetConfetti(i, false);
          else c[j + 1] = 0.02;
        }
      }
      this.e.set(c[j + 4], c[j + 5], 0);
      this.q.setFromEuler(this.e);
      this.v.set(c[j], active ? c[j + 1] : -50, c[j + 2]);
      this.m.compose(this.v, this.q, this.sc);
      this.confetti.setMatrixAt(i, this.m);
    }
    this.confetti.instanceMatrix.needsUpdate = true;

    // Spots leicht bewegen
    this.spots.forEach((sp, i) => {
      sp.intensity = (i === 0 ? 140 : 90) * (0.85 + 0.15 * Math.sin(t * 2 + i));
    });
  }

  dispose(): void {
    for (const f of this.figures) f.fig.dispose();
    for (const d of this.disposables) d.dispose();
    this.envRT?.dispose();
    // Fahrzeuge nutzen geteilte, zwischengespeicherte Geometrien – nicht freigeben
    this.scene.clear();
  }
}
