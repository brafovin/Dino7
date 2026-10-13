// Baut die komplette 3D-Umgebung einer Strecke aus den Streckendaten.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Weather } from '../shared/carPhysics';
import { clamp, mulberry32, smoothstep } from '../shared/math';
import { TEAMS } from '../shared/teams';
import { CURB_WIDTH, type EnvDef, SURF_GRASS, SURF_GRAVEL, SURF_PIT, SURF_RUNOFF_ASPHALT, type Track } from '../shared/track';
import type { Quality } from '../settings';
import {
  armcoTexture,
  asphaltTexture,
  banner2Texture,
  bannerTexture,
  checkerTexture,
  curbTexture,
  detailTexture,
  facadeTexture,
  fenceTexture,
  garageTexture,
  grassTexture,
  gravelTexture,
  rubberTexture,
  runoffTexture,
  tecproTexture,
  textDecal,
} from './textures';

const pt = { x: 0, y: 0, z: 0, tx: 0, tz: 1 };

interface RibbonOpts {
  /** Startindex und Anzahl Samples (inkl. letztem); count = n+1 für geschlossene Schleife */
  i0: number;
  count: number;
  dA: (i: number) => number;
  dB: (i: number) => number;
  yA?: (i: number) => number;
  yB?: (i: number) => number;
  vScale?: number;
  uMode?: 'unit' | 'meters';
  uScale?: number;
  step?: number;
}

/** Erzeugt einen Streifen zwischen zwei seitlichen Abständen entlang der Strecke. */
function ribbon(track: Track, o: RibbonOpts): THREE.BufferGeometry {
  const n = track.n;
  const step = o.step ?? 1;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const vScale = o.vScale ?? 8;
  const uScale = o.uScale ?? 8;
  let rows = 0;
  for (let k = 0; k < o.count; k += step) {
    const kk = Math.min(k, o.count - 1);
    const i = (o.i0 + kk) % n;
    const s = (o.i0 + kk) * track.spacing;
    const a = o.dA(i);
    const b = o.dB(i);
    track.pointAt(s, a, pt);
    pos.push(pt.x, pt.y + (o.yA ? o.yA(i) : 0), pt.z);
    track.pointAt(s, b, pt);
    pos.push(pt.x, pt.y + (o.yB ? o.yB(i) : 0), pt.z);
    if (o.uMode === 'meters') uv.push(a / uScale, s / vScale, b / uScale, s / vScale);
    else uv.push(0, s / vScale, 1, s / vScale);
    rows++;
    if (kk === o.count - 1) break;
  }
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2;
    // Dreiecke so orientieren, dass die Oberseite nach oben zeigt (A links von B oder umgekehrt)
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Normalen nach oben ausrichten
  const nrm = g.getAttribute('normal');
  let up = 0;
  for (let i = 0; i < nrm.count; i++) up += nrm.getY(i);
  if (up < 0) {
    for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/** Senkrechte Wand entlang eines seitlichen Abstands. */
function wall(track: Track, i0: number, count: number, d: (i: number) => number, h0: number, h1: number, vScale: number, uPerMeter: number): THREE.BufferGeometry {
  const n = track.n;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let rows = 0;
  let acc = 0;
  let px = 0;
  let pz = 0;
  for (let k = 0; k < count; k++) {
    const i = (i0 + k) % n;
    const s = (i0 + k) * track.spacing;
    track.pointAt(s, d(i), pt);
    if (k > 0) acc += Math.hypot(pt.x - px, pt.z - pz);
    px = pt.x;
    pz = pt.z;
    pos.push(pt.x, pt.y + h0, pt.z, pt.x, pt.y + h1, pt.z);
    uv.push(acc * uPerMeter, 0, acc * uPerMeter, vScale);
    rows++;
  }
  for (let r = 0; r < rows - 1; r++) {
    const a = r * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Zusammenhängende Bereiche, in denen pred(i) wahr ist. */
function runs(n: number, pred: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  // Startpunkt suchen, an dem pred falsch ist (sonst geschlossene Schleife)
  let base = 0;
  while (base < n && pred(base)) base++;
  if (base === n) return [[0, n + 1]];
  for (let c = 1; c <= n; c++) {
    const i = (base + c) % n;
    const p = pred(i) && c < n;
    if (p && start < 0) start = base + c;
    if (!p && start >= 0) {
      out.push([start % n, base + c - start + 1]);
      start = -1;
    }
  }
  return out;
}

// Einfaches Value-Noise für Geländehügel
function valueNoise(seed: number) {
  const rnd = mulberry32(seed);
  const perm = new Float32Array(512);
  for (let i = 0; i < 512; i++) perm[i] = rnd();
  const hash = (x: number, z: number) => perm[(((x * 73856093) ^ (z * 19349663)) >>> 0) % 512];
  return (x: number, z: number): number => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = x - xi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = zf * zf * (3 - 2 * zf);
    const a = hash(xi, zi);
    const b = hash(xi + 1, zi);
    const c = hash(xi, zi + 1);
    const d = hash(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

export interface TrackSceneOptions {
  quality: Quality;
  weather: Weather;
}

export class TrackScene {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: THREE.Mesh;
  readonly startLightMats: THREE.MeshStandardMaterial[] = [];
  readonly fog: THREE.FogExp2;
  readonly sunDir = new THREE.Vector3();
  private readonly track: Track;
  private readonly env: EnvDef;
  private readonly quality: Quality;
  private readonly weather: Weather;
  private readonly rng: () => number;
  private readonly disposables: { dispose(): void }[] = [];
  private noise = valueNoise(17);
  private terrainH: ((x: number, z: number) => number) | null = null;
  private exclusions: { x: number; z: number; r: number }[] = [];
  private hotelMat: THREE.MeshStandardMaterial | null = null;
  private time = 0;
  waterLevel = -1000;
  readonly bgColor: THREE.Color;
  /** Für die Kamera-/Szenen-Begrenzung */
  readonly center = new THREE.Vector3();
  readonly radius: number;

  constructor(track: Track, opts: TrackSceneOptions) {
    this.track = track;
    this.env = track.def.env;
    this.quality = opts.quality;
    this.weather = opts.weather;
    this.rng = mulberry32(1337);
    const env = this.env;
    this.center.set((track.minX + track.maxX) / 2, (track.minY + track.maxY) / 2, (track.minZ + track.maxZ) / 2);
    this.radius = Math.hypot(track.maxX - track.minX, track.maxZ - track.minZ) / 2;

    const wet = opts.weather === 'wet';
    const skyTop = new THREE.Color(env.skyTop);
    const skyHor = new THREE.Color(env.skyHorizon);
    const fogC = new THREE.Color(env.fog);
    if (wet) {
      const grey = new THREE.Color('#7d8690');
      skyTop.lerp(new THREE.Color('#5d6670'), 0.75);
      skyHor.lerp(grey, 0.7);
      fogC.lerp(grey, 0.7);
    }
    this.bgColor = fogC.clone();
    this.fog = new THREE.FogExp2(fogC.getHex(), env.fogDensity * (wet ? 1.8 : 1));

    // Licht
    const el = (env.sunElevation * Math.PI) / 180;
    const az = (env.sunAzimuth * Math.PI) / 180;
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    this.sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity * (wet ? 0.45 : 1));
    this.sun.castShadow = opts.quality !== 'low';
    const sm = opts.quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const ext = opts.quality === 'high' ? 70 : 55;
    const cam = this.sun.shadow.camera;
    cam.left = -ext;
    cam.right = ext;
    cam.top = ext;
    cam.bottom = -ext;
    cam.near = 1;
    cam.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.group.add(this.sun);
    this.group.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiIntensity * (wet ? 0.85 : 1));
    this.group.add(this.hemi);
    if (env.floodlights) {
      // Flutlicht: zusätzliches, schattenloses Oberlicht
      const flood = new THREE.DirectionalLight('#fff4e8', 1.6);
      flood.position.set(0.2, 1, 0.1);
      this.group.add(flood);
      const amb = new THREE.AmbientLight('#6a6f8a', 0.6);
      this.group.add(amb);
    }

    this.sky = this.buildSky(skyTop, skyHor, new THREE.Color(env.ground));
    this.group.add(this.sky);

    this.buildRoad();
    this.buildCurbsAndRunoff();
    this.buildWalls();
    this.buildPit();
    this.buildStartGantry();
    this.buildGrandstands();
    this.buildTerrain();
    this.buildBridges();
    this.buildTunnel();
    this.buildHotel();
    this.buildFloodlights();
    this.buildBrakeBoards();
    this.buildBuildings();
    this.buildTrees();
    this.buildMountains();
    this.buildLandmarks();
  }

  // ---------------------------------------------------------------- Hilfen

  private add(geo: THREE.BufferGeometry, mat: THREE.Material, opts: { cast?: boolean; receive?: boolean; name?: string } = {}): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = !!opts.cast && this.quality !== 'low';
    m.receiveShadow = opts.receive ?? true;
    if (opts.name) m.name = opts.name;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    this.group.add(m);
    this.disposables.push(geo);
    return m;
  }

  private mat(p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(p);
    this.disposables.push(m);
    return m;
  }

  private buildSky(top: THREE.Color, hor: THREE.Color, ground: THREE.Color): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: top },
        horizon: { value: hor },
        bottom: { value: ground.clone().lerp(hor, 0.5) },
        sunDir: { value: this.sunDir },
        sunColor: { value: new THREE.Color(this.env.sunColor).multiplyScalar(this.weather === 'wet' ? 0.15 : 1) },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize((modelMatrix * vec4(position,1.0)).xyz - cameraPosition); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; varying vec3 vDir;
        void main(){ vec3 d = normalize(vDir); float h = d.y; vec3 col = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, bottom, pow(clamp(-h,0.0,1.0), 0.35));
        float s = max(dot(d, normalize(sunDir)), 0.0); col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 14.0) * 0.22);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const g = new THREE.SphereGeometry(4000, 32, 16);
    this.disposables.push(g, mat);
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = false;
    m.renderOrder = -10;
    return m;
  }

  // ---------------------------------------------------------------- Fahrbahn

  private buildRoad(): void {
    const tr = this.track;
    const wet = this.weather === 'wet';
    const road = this.mat({ map: asphaltTexture(), roughness: wet ? 0.28 : 0.86, metalness: wet ? 0.15 : 0, color: wet ? 0x8c8f96 : 0xffffff });
    const g = ribbon(tr, { i0: 0, count: tr.n + 1, dA: (i) => tr.halfW[i], dB: (i) => -tr.halfW[i], uMode: 'meters', uScale: 10, vScale: 10 });
    this.add(g, road, { name: 'road' });
    // Gummiabrieb auf der Ideallinie
    const rub = this.mat({ map: rubberTexture(), transparent: true, opacity: wet ? 0.35 : 0.8, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1 });
    const rl = tr.raceLine;
    this.add(ribbon(tr, { i0: 0, count: tr.n + 1, dA: (i) => rl[i] + 1.3, dB: (i) => rl[i] - 1.3, yA: () => 0.004, yB: () => 0.004, vScale: 12 }), rub, { name: 'rubber' });
    // weiße Randlinien
    const white = this.mat({ color: 0xf2f2f2, roughness: 0.6 });
    const lineGeo = mergeGeometries([
      ribbon(tr, { i0: 0, count: tr.n + 1, dA: (i) => tr.halfW[i] - 0.05, dB: (i) => tr.halfW[i] - 0.3, yA: () => 0.008, yB: () => 0.008 }),
      ribbon(tr, { i0: 0, count: tr.n + 1, dA: (i) => -tr.halfW[i] + 0.3, dB: (i) => -tr.halfW[i] + 0.05, yA: () => 0.008, yB: () => 0.008 }),
    ]);
    this.add(lineGeo!, white, { name: 'lines' });
    // Start-/Ziellinie (Schachbrett)
    const hw = tr.halfW[0];
    const quads: THREE.BufferGeometry[] = [];
    const quad = (s0: number, s1: number, d0: number, d1: number, y = 0.012, u0 = 0, u1 = 1, v0 = 0, v1 = 1) => {
      const p: number[] = [];
      for (const [s, d] of [
        [s0, d0],
        [s0, d1],
        [s1, d0],
        [s1, d1],
      ]) {
        tr.pointAt(s, d, pt);
        p.push(pt.x, pt.y + y, pt.z);
      }
      const gq = new THREE.BufferGeometry();
      gq.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      gq.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u0, v1, u1, v1], 2));
      gq.setIndex([0, 2, 1, 1, 2, 3]);
      gq.computeVertexNormals();
      if (gq.getAttribute('normal').getY(0) < 0) {
        gq.setIndex([0, 1, 2, 1, 3, 2]);
        gq.computeVertexNormals();
      }
      return gq;
    };
    const checker = this.mat({ map: checkerTexture(), roughness: 0.6 });
    const chk = quad(-0.8, 0.8, hw, -hw, 0.013, 0, (hw * 2) / 4, 0, 0.4);
    const ct = checkerTexture();
    ct.repeat.set(1, 1);
    this.add(chk, checker, { name: 'startline' });
    // Startaufstellung
    for (let k = 0; k < 22; k++) {
      const slot = tr.gridSlot(k);
      quads.push(quad(slot.s + 3.1, slot.s + 3.3, slot.d + 1.1, slot.d - 1.1));
      quads.push(quad(slot.s + 1.6, slot.s + 3.3, slot.d + 1.1, slot.d + 0.95));
      quads.push(quad(slot.s + 1.6, slot.s + 3.3, slot.d - 0.95, slot.d - 1.1));
    }
    // Boxengasse: Linien und Boxen
    const pit = tr.pit;
    const side = pit.side;
    const L = tr.length;
    const span = tr.deltaS(pit.sEntry, pit.sExit);
    for (let x = 0; x < span; x += 2) {
      const s = pit.sEntry + x;
      const s2 = s + 2;
      const dd = Math.abs(tr.pitPathD(s, null));
      if (dd < 0.1) continue;
      // Linie zur Rennstrecke hin
      if (!tr.inRange(s, pit.sWallStart, pit.sWallEnd)) {
        const d1 = Math.max(tr.halfW[tr.indexAt(s)] + 0.2, dd - 3.2);
        quads.push(quad(s, s2, side * (d1 + 0.15), side * d1));
      }
    }
    for (const b of pit.boxes) {
      quads.push(quad(b - 4, b + 4, side * (pit.boxLane - 2.4), side * (pit.boxLane - 2.6)));
      quads.push(quad(b - 4, b + 4, side * (pit.boxLane + 2.6), side * (pit.boxLane + 2.4)));
    }
    // Tempolimit-Linien
    quads.push(quad(pit.sWallStart - 40, pit.sWallStart - 39.6, side * pit.wallD, side * pit.outerD));
    quads.push(quad(pit.sWallEnd + 20, pit.sWallEnd + 20.4, side * pit.wallD, side * pit.outerD));
    void L;
    this.add(mergeGeometries(quads)!, white, { name: 'markings' });
    // Teamfarben in den Boxen
    const boxGeos: THREE.BufferGeometry[] = [];
    const boxCols: number[] = [];
    pit.boxes.forEach((b, t) => {
      const q = quad(b - 3.6, b + 3.6, side * (pit.boxLane - 2.3), side * (pit.boxLane + 2.3), 0.01);
      q.deleteAttribute('uv');
      const c = new THREE.Color(TEAMS[t % TEAMS.length].livery.primary).multiplyScalar(0.55);
      for (let i = 0; i < 4; i++) boxCols.push(c.r, c.g, c.b);
      boxGeos.push(q);
    });
    const bg = mergeGeometries(boxGeos)!;
    bg.setAttribute('color', new THREE.Float32BufferAttribute(boxCols, 3));
    this.add(bg, this.mat({ vertexColors: true, roughness: 0.7 }), { name: 'pitboxes' });
  }

  private buildCurbsAndRunoff(): void {
    const tr = this.track;
    const n = tr.n;
    const curbMat = this.mat({ map: curbTexture(), roughness: 0.55 });
    const curbGeos: THREE.BufferGeometry[] = [];
    for (const side of [1, -1]) {
      const arr = side > 0 ? tr.curbL : tr.curbR;
      for (const [i0, count] of runs(n, (i) => arr[i] === 1)) {
        curbGeos.push(
          ribbon(tr, {
            i0,
            count,
            dA: (i) => side * tr.halfW[i],
            dB: (i) => side * (tr.halfW[i] + CURB_WIDTH),
            yA: () => 0.012,
            yB: () => 0.045,
            vScale: 3,
          }),
        );
      }
    }
    if (curbGeos.length) this.add(mergeGeometries(curbGeos)!, curbMat, { name: 'curbs' });

    // Auslaufzonen je Belag
    const grassMat = this.mat({ map: grassTexture(), color: this.env.grass, roughness: 0.95 });
    const gravelMat = this.mat({ map: gravelTexture(), roughness: 1 });
    const runoffMat = this.mat({ map: runoffTexture(), roughness: 0.9 });
    const pitMat = this.mat({ map: asphaltTexture(), color: 0x9a9da3, roughness: 0.8 });
    const typeMats: [number, THREE.Material][] = [
      [SURF_GRASS, grassMat],
      [SURF_GRAVEL, gravelMat],
      [SURF_RUNOFF_ASPHALT, runoffMat],
      [SURF_PIT, pitMat],
    ];
    for (const [type, mat] of typeMats) {
      const geos: THREE.BufferGeometry[] = [];
      for (const side of [1, -1]) {
        const tArr = side > 0 ? tr.runTypeL : tr.runTypeR;
        const cArr = side > 0 ? tr.curbL : tr.curbR;
        const bArr = side > 0 ? tr.barL : tr.barR;
        for (const [i0, count] of runs(n, (i) => tArr[i] === type)) {
          geos.push(
            ribbon(tr, {
              i0,
              count: count + 1,
              dA: (i) => side * (tr.halfW[i] + (cArr[i] ? CURB_WIDTH : 0)),
              dB: (i) => side * Math.max(tr.halfW[i] + 0.5, bArr[i] - 0.05),
              yA: () => (type === SURF_PIT ? 0.005 : -0.004),
              yB: () => (type === SURF_PIT ? 0.005 : -0.03),
              uMode: 'meters',
              uScale: type === SURF_GRASS ? 12 : 6,
              vScale: type === SURF_GRASS ? 12 : 6,
            }),
          );
        }
      }
      if (geos.length) this.add(mergeGeometries(geos)!, mat, { name: `runoff${type}` });
    }
  }

  private buildWalls(): void {
    const tr = this.track;
    const n = tr.n;
    const def = tr.def;
    const banner = this.mat({ map: bannerTexture(), roughness: 0.6, side: THREE.DoubleSide });
    const banner2 = this.mat({ map: banner2Texture(), roughness: 0.6, side: THREE.DoubleSide });
    const armco = this.mat({ map: armcoTexture(), roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide });
    const tecpro = this.mat({ map: tecproTexture(), roughness: 0.7, side: THREE.DoubleSide });
    const wallH = 1.1;
    const isCorner = (i: number, side: number) => (side > 0 ? tr.runL[i] : tr.runR[i]) > def.runoff + 6;
    for (const side of [1, -1]) {
      const bArr = side > 0 ? tr.barL : tr.barR;
      const tunnel = (i: number) => tr.flags[i] === 1;
      const kinds: [(i: number) => boolean, THREE.Material, number][] = [
        [(i) => isCorner(i, side) && !tunnel(i), def.barrier === 'armco' ? tecpro : tecpro, 1 / 8],
        [(i) => !isCorner(i, side) && !tunnel(i), def.barrier === 'armco' ? armco : side > 0 ? banner : banner2, def.barrier === 'armco' ? 1 / 6 : 1 / 64],
      ];
      for (const [pred, mat, uPer] of kinds) {
        const geos: THREE.BufferGeometry[] = [];
        for (const [i0, count] of runs(n, pred)) {
          geos.push(wall(tr, i0, count + 1, (i) => side * bArr[i], -0.3, wallH, 1, uPer));
        }
        if (geos.length) this.add(mergeGeometries(geos)!, mat, { cast: true, name: 'wall' });
      }
      // Fangzaun
      if (this.quality !== 'low') {
        const fence = this.mat({ map: fenceTexture(), transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4 });
        (fence.map as THREE.Texture).repeat.set(1, 1);
        const geos: THREE.BufferGeometry[] = [];
        for (const [i0, count] of runs(n, (i) => !tunnel(i) && tr.py[i] - tr.minY < 1e6)) {
          geos.push(wall(tr, i0, count + 1, (i) => side * (bArr[i] + 0.1), wallH, wallH + 2.8, 1, 1 / 3));
        }
        if (geos.length) this.add(mergeGeometries(geos)!, fence, { name: 'fence' });
      }
    }
  }

  // ---------------------------------------------------------------- Boxen

  private buildPit(): void {
    const tr = this.track;
    const pit = tr.pit;
    const side = pit.side;
    const i0 = tr.indexAt(pit.sWallStart);
    const count = Math.round(tr.deltaS(pit.sWallStart, pit.sWallEnd) / tr.spacing) + 1;
    // Boxenmauer
    const concrete = this.mat({ map: bannerTexture(), roughness: 0.6, side: THREE.DoubleSide });
    const top = this.mat({ color: 0xd8d8d8, roughness: 0.7 });
    const w1 = wall(tr, i0, count, () => side * (pit.wallD - 0.2), 0, 1.15, 1, 1 / 64);
    const w2 = wall(tr, i0, count, () => side * (pit.wallD + 0.2), 0, 1.15, 1, 1 / 64);
    this.add(mergeGeometries([w1, w2])!, concrete, { cast: true, name: 'pitwall' });
    this.add(ribbon(tr, { i0, count, dA: () => side * (pit.wallD - 0.2), dB: () => side * (pit.wallD + 0.2), yA: () => 1.15, yB: () => 1.15 }), top);
    // Gebäude mit Garagen
    const bStart = tr.indexAt(pit.sWallStart - 20);
    const bCount = Math.round((tr.deltaS(pit.sWallStart, pit.sWallEnd) + 40) / tr.spacing) + 1;
    const facade = this.mat({ map: garageTexture(), roughness: 0.6, side: THREE.DoubleSide });
    const roofMat = this.mat({ color: 0xbfc4ca, roughness: 0.6 });
    const glass = this.mat({ color: 0x223344, roughness: 0.15, metalness: 0.6 });
    const o = pit.outerD + 0.4;
    this.add(wall(tr, bStart, bCount, () => side * o, 0, 6, 1, 1 / 16), facade, { cast: true, name: 'garages' });
    this.add(wall(tr, bStart, bCount, () => side * o, 6, 11, 1, 1 / 30), glass, { cast: true });
    this.add(ribbon(tr, { i0: bStart, count: bCount, dA: () => side * o, dB: () => side * (o + 22), yA: () => 11, yB: () => 11 }), roofMat, { cast: true });
    this.add(wall(tr, bStart, bCount, () => side * (o + 22), 0, 11, 1, 1 / 30), roofMat);
    // Teamschilder über den Garagen
    pit.boxes.forEach((b, t) => {
      const team = TEAMS[t % TEAMS.length];
      const tex = textDecal(team.name.toUpperCase(), '#ffffff', team.livery.primary, 512, 96);
      const m = this.mat({ map: tex, roughness: 0.5, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.25 });
      tr.pointAt(b, side * (o - 0.05), pt);
      const g = new THREE.PlaneGeometry(9, 1.6);
      const mesh = new THREE.Mesh(g, m);
      mesh.position.set(pt.x, pt.y + 6.9, pt.z);
      mesh.rotation.y = Math.atan2(pt.tx, pt.tz) + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
      this.group.add(mesh);
      this.disposables.push(g);
      this.exclusions.push({ x: pt.x, z: pt.z, r: 30 });
    });
  }

  private buildStartGantry(): void {
    const tr = this.track;
    const s = 6;
    const hw = tr.halfW[0];
    tr.pointAt(s, 0, pt);
    const g = new THREE.Group();
    g.position.set(pt.x, pt.y, pt.z);
    g.rotation.y = Math.atan2(pt.tx, pt.tz);
    const steel = this.mat({ color: 0x2a2d33, roughness: 0.5, metalness: 0.6 });
    const span = Math.min(tr.barL[0], tr.barR[0]) * 2;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span, 0.9, 0.9), steel);
    beam.position.y = 7.2;
    g.add(beam);
    for (const x of [-span / 2, span / 2]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.7, 7.6, 0.7), steel);
      p.position.set(x, 3.8, 0);
      g.add(p);
    }
    // 5 Ampelsäulen mit je 2 roten Lichtern (beidseitig sichtbar)
    for (let k = 0; k < 5; k++) {
      const m = this.mat({ color: 0x220000, emissive: 0xff0a0a, emissiveIntensity: 0, roughness: 0.3 });
      this.startLightMats.push(m);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.6, 0.5), steel);
      const x = (k - 2) * 1.1;
      housing.position.set(x, 6.1, 0);
      g.add(housing);
      for (const yy of [5.75, 6.45]) {
        for (const zz of [-0.27, 0.27]) {
          const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.24, 16), m);
          lamp.position.set(x, yy, zz);
          lamp.rotation.y = zz > 0 ? 0 : Math.PI;
          g.add(lamp);
        }
      }
    }
    void hw;
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = this.quality !== 'low';
    });
    this.group.add(g);
  }

  setStartLights(n: number): void {
    this.startLightMats.forEach((m, i) => {
      m.emissiveIntensity = i < n ? 6 : 0;
      m.color.setHex(i < n ? 0xff2020 : 0x220000);
    });
  }

  // ---------------------------------------------------------------- Tribünen

  private grandstandSpots(): { s: number; len: number; side: number }[] {
    const tr = this.track;
    const spots: { s: number; len: number; side: number }[] = [];
    // Gegenüber der Boxen an der Start-Ziel-Geraden
    spots.push({ s: -170, len: 300, side: -tr.pit.side });
    // Außen an langsamen Kurven
    const slow = tr.corners.slice().sort((a, b) => a.minRadius - b.minRadius).slice(0, this.quality === 'low' ? 3 : 6);
    for (const c of slow) {
      const s = c.apex * tr.spacing;
      spots.push({ s: s - 50, len: 110, side: -c.dir });
    }
    return spots;
  }

  private buildGrandstands(): void {
    const tr = this.track;
    const rows = 12;
    const stepD = 0.95;
    const stepH = 0.5;
    const structMat = this.mat({ color: 0xc9ccd1, roughness: 0.8 });
    const seatMat = this.mat({ color: 0x3b4a66, roughness: 0.7 });
    const roofMat = this.mat({ color: 0xe8eaed, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide });
    const crowd: THREE.Matrix4[] = [];
    const crowdCol: THREE.Color[] = [];
    const geos: THREE.BufferGeometry[] = [];
    const seatGeos: THREE.BufferGeometry[] = [];
    const roofGeos: THREE.BufferGeometry[] = [];
    const density = this.quality === 'high' ? 1.6 : this.quality === 'medium' ? 1.0 : 0.5;
    const palette = ['#d62828', '#f77f00', '#fcbf49', '#eae2b7', '#003049', '#2a9d8f', '#e9c46a', '#264653', '#ffffff', '#8338ec', '#3a86ff', '#ff006e', '#222222'];
    for (const spot of this.grandstandSpots()) {
      const i0 = tr.indexAt(spot.s);
      const count = Math.round(spot.len / tr.spacing);
      const side = spot.side;
      const bArr = side > 0 ? tr.barL : tr.barR;
      // Kollisionsprüfung mit anderen Streckenteilen
      let ok = true;
      for (let k = 0; k < count && ok; k += 3) {
        const i = (i0 + k) % tr.n;
        const off = bArr[i] + 5 + rows * stepD + 2;
        tr.pointAt(i * tr.spacing, side * off, pt);
        const nr = tr.nearest(pt.x, pt.z, 80);
        if (nr.i >= 0 && Math.abs(tr.deltaS(nr.i * tr.spacing, i * tr.spacing)) > 60) {
          const bar = Math.max(tr.barL[nr.i], tr.barR[nr.i]);
          if (nr.dist < bar + 6) ok = false;
        }
        if (tr.inRange(i * tr.spacing, tr.pit.sEntry - 30, tr.pit.sExit + 30) && side === tr.pit.side) ok = false;
      }
      if (!ok) continue;
      const base = (i: number) => bArr[i] + 5;
      for (let r = 0; r < rows; r++) {
        const d0 = (i: number) => side * (base(i) + r * stepD);
        const d1 = (i: number) => side * (base(i) + (r + 1) * stepD);
        // Stufe (horizontal) und Setzstufe (vertikal)
        seatGeos.push(ribbon(tr, { i0, count, dA: d0, dB: d1, yA: () => (r + 1) * stepH, yB: () => (r + 1) * stepH }));
        geos.push(wall(tr, i0, count, d0, r * stepH, (r + 1) * stepH, 1, 1 / 8));
        // Publikum
        for (let k = 0; k < count; k++) {
          const per = density * 2.2;
          for (let q = 0; q < per; q++) {
            if (this.rng() < 0.12) continue;
            const s = (i0 + k + this.rng()) * tr.spacing;
            const d = side * (base(0) + (r + 0.45 + (this.rng() - 0.5) * 0.2) * stepD);
            tr.pointAt(s, d, pt);
            const m = new THREE.Matrix4();
            const sc = 0.85 + this.rng() * 0.3;
            const face = Math.atan2(pt.tx, pt.tz) + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
            m.compose(new THREE.Vector3(pt.x, pt.y + (r + 1) * stepH + 0.42 * sc, pt.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), face), new THREE.Vector3(sc, sc, sc));
            crowd.push(m);
            crowdCol.push(new THREE.Color(palette[Math.floor(this.rng() * palette.length)]));
          }
        }
      }
      // Rückwand und Dach
      const back = (i: number) => side * (base(i) + rows * stepD);
      geos.push(wall(tr, i0, count, back, 0, rows * stepH + 4.5, 1, 1 / 8));
      roofGeos.push(ribbon(tr, { i0, count, dA: (i) => side * (base(i) - 1.5), dB: back, yA: () => rows * stepH + 4.8, yB: () => rows * stepH + 4.5 }));
      for (let k = 0; k < count; k += 8) {
        const i = (i0 + k) % tr.n;
        tr.pointAt(i * tr.spacing, side * (base(i) - 1.2), pt);
        const pole = new THREE.CylinderGeometry(0.15, 0.15, rows * stepH + 4.8, 6);
        pole.translate(pt.x, pt.y + (rows * stepH + 4.8) / 2, pt.z);
        geos.push(pole.toNonIndexed());
      }
      tr.pointAt((i0 + count / 2) * tr.spacing, side * (bArr[i0] + 10), pt);
      this.exclusions.push({ x: pt.x, z: pt.z, r: spot.len / 2 + 15 });
    }
    if (geos.length) {
      const norm = geos.map((g) => {
        const gg = g.index ? g.toNonIndexed() : g;
        for (const k of Object.keys(gg.attributes)) if (k !== 'position' && k !== 'normal') gg.deleteAttribute(k);
        if (!gg.getAttribute('normal')) gg.computeVertexNormals();
        return gg;
      });
      this.add(mergeGeometries(norm)!, structMat, { cast: true, name: 'stands' });
      this.add(mergeGeometries(seatGeos)!, seatMat, { name: 'seats' });
      this.add(mergeGeometries(roofGeos)!, roofMat, { cast: true, name: 'roofs' });
    }
    if (crowd.length) {
      // Zuschauer als zur Strecke gerichtete Flächen (wenige Dreiecke)
      const pg = new THREE.PlaneGeometry(0.46, 0.8);
      const pm = this.mat({ roughness: 0.9, side: THREE.DoubleSide });
      const inst = new THREE.InstancedMesh(pg, pm, crowd.length);
      crowd.forEach((m, i) => {
        inst.setMatrixAt(i, m);
        inst.setColorAt(i, crowdCol[i]);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      this.group.add(inst);
      this.disposables.push(pg);
    }
  }

  // ---------------------------------------------------------------- Gelände

  private isWater(x: number, z: number): number {
    const w = this.env.water;
    if (!w) return 0;
    const a = (w.dir * Math.PI) / 180;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    const proj = (x - this.center.x) * dx + (z - this.center.z) * dz;
    return smoothstep(w.dist, w.dist + 40, proj);
  }

  private buildTerrain(): void {
    const tr = this.track;
    const env = this.env;
    const margin = 450;
    const minX = tr.minX - margin;
    const maxX = tr.maxX + margin;
    const minZ = tr.minZ - margin;
    const maxZ = tr.maxZ + margin;
    const cell = this.quality === 'high' ? 7 : this.quality === 'medium' ? 10 : 15;
    const nx = Math.ceil((maxX - minX) / cell);
    const nz = Math.ceil((maxZ - minZ) / cell);
    const amp = env.theme === 'forest' ? 26 : env.theme === 'hills' ? 18 : env.theme === 'city' ? 14 : env.theme === 'dunes' ? 9 : env.theme === 'desert' ? 4 : 5;
    const baseY = (tr.minY + tr.maxY) / 2 - 1;
    const farY = tr.minY - 4;
    const waterLevel = env.water ? tr.minY - 1.2 : -1e6;
    this.waterLevel = waterLevel;
    const noise = this.noise;
    const hills = (x: number, z: number) => (noise(x / 380, z / 380) - 0.5) * amp + (noise(x / 120 + 50, z / 120) - 0.5) * amp * 0.35;
    const heightAt = (x: number, z: number): { h: number; near: number } => {
      const nr = tr.nearest(x, z, 260);
      let h = baseY + hills(x, z);
      let near = Infinity;
      if (nr.i >= 0) {
        // Bei Brücken: niedrigsten nahen Abschnitt nehmen
        let bestY = Infinity;
        let bestI = nr.i;
        tr.forEachNear(x, z, Math.min(nr.dist + 7, 70), (j) => {
          if (tr.py[j] < bestY) {
            bestY = tr.py[j];
            bestI = j;
          }
        });
        const i = bestI;
        const dx = x - tr.px[i];
        const dz = z - tr.pz[i];
        const lat = dx * tr.nx[i] + dz * tr.nz[i];
        const dist = Math.hypot(dx, dz);
        near = dist;
        const bar = Math.max(lat > 0 ? tr.barL[i] : tr.barR[i], tr.halfW[i] + 2);
        const trackH = tr.heightAt(i * tr.spacing, clamp(lat, -bar, bar)) - 0.35;
        const t = smoothstep(bar + 2, bar + 110, dist);
        h = trackH + (h - trackH) * t;
      }
      // Rand des Geländes sanft auf die Höhe des fernen Bodens absenken
      const edge = Math.min(x - minX, maxX - x, z - minZ, maxZ - z);
      h = farY + 0.5 + (h - farY - 0.5) * smoothstep(0, 140, edge);
      const w = this.isWater(x, z) * smoothstep(40, 90, near);
      if (w > 0) h = h + (waterLevel - 3 - h) * w;
      return { h, near };
    };
    this.terrainH = (x, z) => heightAt(x, z).h;
    const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
    const col = new Float32Array((nx + 1) * (nz + 1) * 3);
    const uv = new Float32Array((nx + 1) * (nz + 1) * 2);
    const grass = new THREE.Color(env.grass);
    const ground = new THREE.Color(env.ground);
    const sand = new THREE.Color('#cdb88a');
    const c = new THREE.Color();
    let p = 0;
    for (let iz = 0; iz <= nz; iz++) {
      for (let ix = 0; ix <= nx; ix++) {
        const x = minX + ix * cell;
        const z = minZ + iz * cell;
        const { h, near } = heightAt(x, z);
        pos[p * 3] = x;
        pos[p * 3 + 1] = h;
        pos[p * 3 + 2] = z;
        uv[p * 2] = x / 7;
        uv[p * 2 + 1] = z / 7;
        const nv = noise(x / 60, z / 60);
        c.copy(grass).lerp(ground, smoothstep(20, 160, near) * 0.6 + nv * 0.25);
        if (env.theme === 'dunes' || env.theme === 'desert') c.lerp(sand, smoothstep(0.35, 0.75, noise(x / 140 + 9, z / 140)) * smoothstep(25, 60, near));
        if (h < waterLevel + 1.5) c.copy(sand);
        c.multiplyScalar(0.92 + nv * 0.16);
        col[p * 3] = c.r;
        col[p * 3 + 1] = c.g;
        col[p * 3 + 2] = c.b;
        p++;
      }
    }
    const idx: number[] = [];
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const a = iz * (nx + 1) + ix;
        const b = a + 1;
        const d = a + nx + 1;
        const e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tm = this.mat({ vertexColors: true, map: detailTexture(), roughness: 0.97 });
    this.add(g, tm, { name: 'terrain' });
    // Ferner Boden
    const far = new THREE.PlaneGeometry(14000, 14000);
    far.rotateX(-Math.PI / 2);
    far.translate(this.center.x, farY, this.center.z);
    this.add(far, this.mat({ color: ground.clone().lerp(grass, 0.5), roughness: 1 }), { receive: false, name: 'farground' });
    // Wasser
    if (env.water) {
      const wg = new THREE.PlaneGeometry(14000, 14000);
      wg.rotateX(-Math.PI / 2);
      wg.translate(this.center.x, waterLevel, this.center.z);
      const wm = this.mat({ color: env.floodlights ? 0x0c1a2a : 0x1f5f86, roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.92 });
      const water = this.add(wg, wm, { receive: false, name: 'water' });
      water.renderOrder = 1;
      // Boote im Hafen
      const boats: THREE.Matrix4[] = [];
      for (let k = 0; k < 160; k++) {
        const x = this.center.x + (this.rng() - 0.5) * (tr.maxX - tr.minX + 900);
        const z = this.center.z + (this.rng() - 0.5) * (tr.maxZ - tr.minZ + 900);
        if (this.isWater(x, z) < 1) continue;
        const nr = tr.nearest(x, z, 120);
        if (nr.i >= 0 && nr.dist < 70) continue;
        const sc = 0.6 + this.rng() * 1.8;
        boats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, waterLevel + 0.6 * sc, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * 6), new THREE.Vector3(sc, sc, sc)));
      }
      if (boats.length) {
        const bgeo = mergeGeometries([new THREE.BoxGeometry(5, 1.6, 18).toNonIndexed(), new THREE.BoxGeometry(3.4, 1.4, 8).translate(0, 1.4, -1).toNonIndexed()])!;
        const inst = new THREE.InstancedMesh(bgeo, this.mat({ color: 0xf4f4f4, roughness: 0.4 }), boats.length);
        boats.forEach((m, i) => inst.setMatrixAt(i, m));
        this.group.add(inst);
        this.disposables.push(bgeo);
      }
    }
  }

  // ---------------------------------------------------------------- Brücken (Suzuka)

  private buildBridges(): void {
    const tr = this.track;
    if (!this.terrainH) return;
    const concrete = this.mat({ color: 0x9ea3aa, roughness: 0.85 });
    const geos: THREE.BufferGeometry[] = [];
    const elevated = (i: number) => tr.py[i] - this.terrainH!(tr.px[i], tr.pz[i]) > 2.2;
    for (const [i0, count] of runs(tr.n, elevated)) {
      const hw = (i: number) => Math.max(tr.barL[i], tr.barR[i]) + 0.2;
      geos.push(ribbon(tr, { i0, count, dA: (i) => hw(i), dB: (i) => -hw(i), yA: () => -0.7, yB: () => -0.7 }));
      geos.push(wall(tr, i0, count, (i) => tr.barL[i] + 0.25, -0.7, 0, 1, 0.1));
      geos.push(wall(tr, i0, count, (i) => -tr.barR[i] - 0.25, -0.7, 0, 1, 0.1));
      for (let k = 2; k < count; k += 8) {
        const i = (i0 + k) % tr.n;
        for (const side of [1, -1]) {
          tr.pointAt(i * tr.spacing, side * (tr.halfW[i] - 1), pt);
          const groundY = this.terrainH(pt.x, pt.z);
          const h = pt.y - 0.7 - groundY;
          if (h < 1) continue;
          const pg = new THREE.BoxGeometry(1.2, h, 1.2);
          pg.translate(pt.x, groundY + h / 2, pt.z);
          geos.push(pg);
        }
      }
    }
    if (!geos.length) return;
    const norm = geos.map((g) => {
      const gg = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(gg.attributes)) if (k !== 'position' && k !== 'normal') gg.deleteAttribute(k);
      return gg;
    });
    const merged = mergeGeometries(norm)!;
    concrete.side = THREE.DoubleSide;
    this.add(merged, concrete, { cast: true, name: 'bridge' });
  }

  // ---------------------------------------------------------------- Monaco-Tunnel

  private buildTunnel(): void {
    const tr = this.track;
    const tunnelRuns = runs(tr.n, (i) => tr.flags[i] === 1);
    if (!tunnelRuns.length) return;
    const wallMat = this.mat({ color: 0xb8b2a6, roughness: 0.9, side: THREE.DoubleSide });
    const lightMat = this.mat({ color: 0xfff1d0, emissive: 0xffe2a8, emissiveIntensity: 2.2 });
    const buildingMat = this.mat({ map: facadeTexture(3), roughness: 0.8, side: THREE.DoubleSide });
    for (const [i0, count] of tunnelRuns) {
      const H = 6.5;
      const geos = [
        wall(tr, i0, count, (i) => tr.barL[i] + 0.1, 0, H, 1, 1 / 10),
        wall(tr, i0, count, (i) => -tr.barR[i] - 0.1, 0, H, 1, 1 / 10),
        ribbon(tr, { i0, count, dA: (i) => tr.barL[i] + 0.1, dB: (i) => -tr.barR[i] - 0.1, yA: () => H, yB: () => H }),
      ];
      // Dach von unten sichtbar machen
      const roof = geos[2];
      const idx = roof.getIndex()!.array as Uint16Array | Uint32Array;
      const flipped = Array.from(idx);
      for (let k = 0; k < flipped.length; k += 3) [flipped[k + 1], flipped[k + 2]] = [flipped[k + 2], flipped[k + 1]];
      roof.setIndex(flipped);
      roof.computeVertexNormals();
      this.add(mergeGeometries(geos.map((g) => g.toNonIndexed()))!, wallMat, { cast: true, name: 'tunnel' });
      // Lichtbänder
      const lights: THREE.BufferGeometry[] = [];
      for (let k = 0; k < count; k += 4) {
        const i = (i0 + k) % tr.n;
        tr.pointAt(i * tr.spacing, 0, pt);
        const lg = new THREE.BoxGeometry(0.5, 0.08, 2.2);
        lg.rotateY(Math.atan2(pt.tx, pt.tz));
        lg.translate(pt.x, pt.y + H - 0.1, pt.z);
        lights.push(lg);
      }
      this.add(mergeGeometries(lights)!, lightMat, { receive: false });
      // Gebäude über dem Tunnel
      const top = ribbon(tr, { i0, count, dA: (i) => tr.barL[i] + 30, dB: (i) => -tr.barR[i] - 4, yA: () => H + 14, yB: () => H + 14 });
      const side1 = wall(tr, i0, count, (i) => tr.barL[i] + 30, 0, H + 14, 3, 1 / 20);
      const side2 = wall(tr, i0, count, (i) => -tr.barR[i] - 4, H, H + 14, 1, 1 / 20);
      this.add(mergeGeometries([top.toNonIndexed(), side1.toNonIndexed(), side2.toNonIndexed()])!, buildingMat, { cast: true });
      const mid = (i0 + count / 2) % tr.n;
      this.exclusions.push({ x: tr.px[Math.floor(mid)], z: tr.pz[Math.floor(mid)], r: count * tr.spacing * 0.6 });
    }
  }

  // ---------------------------------------------------------------- Yas-Hotel

  private buildHotel(): void {
    const tr = this.track;
    const hr = runs(tr.n, (i) => tr.flags[i] === 2);
    if (!hr.length) return;
    const [i0, count] = hr[0];
    const mid = (i0 + Math.floor(count / 2)) % tr.n;
    tr.pointAt(mid * tr.spacing, 0, pt);
    const g = new THREE.Group();
    g.position.set(pt.x, pt.y, pt.z);
    g.rotation.y = Math.atan2(pt.tx, pt.tz);
    const facade = this.mat({ map: facadeTexture(9, true), roughness: 0.5, emissive: 0xffffff, emissiveMap: facadeTexture(9, true), emissiveIntensity: 0.6 });
    const gap = Math.max(tr.barL[mid], tr.barR[mid]) + 6;
    for (const side of [1, -1]) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(26, 42, 70), facade);
      tower.position.set(side * (gap + 13), 21, 0);
      tower.castShadow = true;
      g.add(tower);
    }
    this.hotelMat = this.mat({ color: 0x223355, emissive: 0x3a7bff, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.5, side: THREE.DoubleSide });
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(gap * 2 + 26, 7, 24), this.hotelMat);
    bridge.position.set(0, 18, 0);
    g.add(bridge);
    const shell = new THREE.Mesh(new THREE.TorusGeometry(gap + 30, 3, 6, 40, Math.PI), this.hotelMat);
    shell.rotation.y = Math.PI / 2;
    shell.position.y = 8;
    shell.scale.set(1, 0.6, 1);
    g.add(shell);
    this.group.add(g);
    this.exclusions.push({ x: pt.x, z: pt.z, r: gap + 60 });
  }

  // ---------------------------------------------------------------- Flutlicht

  private buildFloodlights(): void {
    if (!this.env.floodlights) return;
    const tr = this.track;
    const poleGeos: THREE.BufferGeometry[] = [];
    const lampGeos: THREE.BufferGeometry[] = [];
    const every = this.quality === 'low' ? 45 : 30;
    for (let i = 0, k = 0; i < tr.n; i += every, k++) {
      const side = k % 2 ? 1 : -1;
      const bar = side > 0 ? tr.barL[i] : tr.barR[i];
      tr.pointAt(i * tr.spacing, side * (bar + 3), pt);
      const h = 22;
      const pole = new THREE.CylinderGeometry(0.25, 0.35, h, 6);
      pole.translate(pt.x, pt.y + h / 2, pt.z);
      poleGeos.push(pole);
      const lamp = new THREE.BoxGeometry(4, 1.2, 0.6);
      lamp.rotateY(Math.atan2(pt.tx, pt.tz) + Math.PI / 2);
      lamp.translate(pt.x, pt.y + h, pt.z);
      lampGeos.push(lamp);
    }
    this.add(mergeGeometries(poleGeos)!, this.mat({ color: 0x4a4f57, roughness: 0.6, metalness: 0.5 }), { receive: false });
    this.add(mergeGeometries(lampGeos)!, this.mat({ color: 0xffffff, emissive: 0xfff6e0, emissiveIntensity: 4 }), { receive: false });
  }

  // ---------------------------------------------------------------- Bremsschilder

  private buildBrakeBoards(): void {
    const tr = this.track;
    const geos: Record<string, THREE.BufferGeometry[]> = { '100': [], '150': [], '200': [] };
    for (const c of tr.corners) {
      if (c.minRadius > 140) continue;
      const side = -c.dir;
      for (const dist of [100, 150, 200]) {
        const s = c.start * tr.spacing - dist;
        const i = tr.indexAt(s);
        const bar = side > 0 ? tr.barL[i] : tr.barR[i];
        tr.pointAt(s, side * Math.max(tr.halfW[i] + 3, bar - 1.2), pt);
        const g = new THREE.PlaneGeometry(1.4, 0.9);
        g.rotateY(Math.atan2(pt.tx, pt.tz) + Math.PI);
        g.translate(pt.x, pt.y + 1.6, pt.z);
        geos[String(dist)].push(g);
        const post = new THREE.BoxGeometry(0.08, 1.2, 0.08);
        post.translate(pt.x, pt.y + 0.6, pt.z);
        geos['100'].push(post.toNonIndexed().deleteAttribute('uv') as unknown as THREE.BufferGeometry);
      }
    }
    for (const key of Object.keys(geos)) {
      const list = geos[key].filter((g) => g.getAttribute('uv'));
      if (!list.length) continue;
      const tex = textDecal(key, '#111111', '#ffffff', 128, 80);
      this.add(mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)))!, this.mat({ map: tex, roughness: 0.6, side: THREE.DoubleSide }), { receive: false });
    }
  }

  // ---------------------------------------------------------------- Bebauung

  private buildBuildings(): void {
    const env = this.env;
    if (env.buildings <= 0) return;
    const tr = this.track;
    const count = Math.round(env.buildings * (this.quality === 'low' ? 90 : this.quality === 'medium' ? 180 : 280));
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const pastel = env.theme === 'city' ? ['#f2d7b6', '#efe4d2', '#e8c4a8', '#f6efe2', '#d9cbb5', '#f1c9a5', '#e0e6ea'] : ['#d8dde3', '#c9b99a', '#e9e4da', '#b6bcc4'];
    let tries = 0;
    while (mats.length < count && tries < count * 20) {
      tries++;
      const i = Math.floor(this.rng() * tr.n);
      const side = this.rng() < 0.5 ? 1 : -1;
      const bar = side > 0 ? tr.barL[i] : tr.barR[i];
      const w = 14 + this.rng() * 26;
      const d = 12 + this.rng() * 22;
      const off = bar + 4 + d / 2 + this.rng() * (env.theme === 'city' ? 40 : 160);
      tr.pointAt(i * tr.spacing, side * off, pt);
      if (this.isWater(pt.x, pt.z) > 0.2) continue;
      // Abstand zur Strecke prüfen (alle Ecken)
      const nr = tr.nearest(pt.x, pt.z, 120);
      if (nr.i >= 0) {
        const b2 = Math.max(tr.barL[nr.i], tr.barR[nr.i]);
        if (nr.dist < b2 + Math.max(w, d) * 0.75 + 3) continue;
      }
      if (this.exclusions.some((e) => Math.hypot(e.x - pt.x, e.z - pt.z) < e.r + w * 0.5)) continue;
      const h = env.theme === 'city' ? 14 + this.rng() * 48 : 8 + this.rng() * 26;
      const y = this.terrainH ? this.terrainH(pt.x, pt.z) : pt.y;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(pt.x, y + h / 2 - 1, pt.z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(pt.tx, pt.tz)),
        new THREE.Vector3(w, h + 2, d),
      );
      mats.push(m);
      cols.push(new THREE.Color(pastel[Math.floor(this.rng() * pastel.length)]));
      this.exclusions.push({ x: pt.x, z: pt.z, r: Math.max(w, d) * 0.6 });
    }
    if (!mats.length) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const tex = facadeTexture(5, env.floodlights);
    tex.repeat.set(1, 1);
    const mat = this.mat({ map: tex, roughness: 0.8, emissive: env.floodlights ? 0xffffff : 0x000000, emissiveMap: env.floodlights ? tex : null, emissiveIntensity: env.floodlights ? 0.5 : 0 });
    const inst = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((m, k) => {
      inst.setMatrixAt(k, m);
      inst.setColorAt(k, cols[k]);
    });
    inst.castShadow = this.quality === 'high';
    inst.receiveShadow = true;
    this.group.add(inst);
    this.disposables.push(geo);
  }

  private buildTrees(): void {
    const env = this.env;
    const tr = this.track;
    if (env.trees <= 0 || !this.terrainH) return;
    const cap = this.quality === 'low' ? 1500 : this.quality === 'medium' ? 4500 : 9000;
    const area = (tr.maxX - tr.minX + 800) * (tr.maxZ - tr.minZ + 800);
    const target = Math.min(cap, Math.round((area / 1600) * env.trees));
    const positions: { x: number; y: number; z: number; s: number; r: number }[] = [];
    let tries = 0;
    while (positions.length < target && tries < target * 8) {
      tries++;
      const x = tr.minX - 380 + this.rng() * (tr.maxX - tr.minX + 760);
      const z = tr.minZ - 380 + this.rng() * (tr.maxZ - tr.minZ + 760);
      // Waldflächen über Rauschen
      if (this.noise(x / 160 + 3, z / 160) < 0.42 - env.trees * 0.08) continue;
      if (this.isWater(x, z) > 0.05) continue;
      const nr = tr.nearest(x, z, 60);
      if (nr.i >= 0) {
        const bar = Math.max(tr.barL[nr.i], tr.barR[nr.i]);
        if (nr.dist < bar + 9) continue;
      }
      if (this.exclusions.some((e) => Math.hypot(e.x - x, e.z - z) < e.r)) continue;
      positions.push({ x, y: this.terrainH(x, z), z, s: 0.7 + this.rng() * 0.7, r: this.rng() * Math.PI * 2 });
    }
    if (!positions.length) return;
    const type = env.treeType;
    const trunkGeo = type === 'palm' ? new THREE.CylinderGeometry(0.22, 0.32, 9, 6).translate(0, 4.5, 0) : new THREE.CylinderGeometry(0.25, 0.4, 4, 6).translate(0, 2, 0);
    let crownGeo: THREE.BufferGeometry;
    if (type === 'pine') crownGeo = new THREE.ConeGeometry(2.6, 9, 7).translate(0, 8, 0);
    else if (type === 'palm') {
      const leaves: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 7; k++) {
        const leaf = new THREE.ConeGeometry(0.5, 4.2, 4);
        leaf.rotateZ(Math.PI / 2 + 0.5);
        leaf.translate(2.0, 8.6, 0);
        leaf.rotateY((k / 7) * Math.PI * 2);
        leaves.push(leaf.toNonIndexed());
      }
      crownGeo = mergeGeometries(leaves)!;
    } else crownGeo = new THREE.IcosahedronGeometry(3.4, 1).scale(1, 0.85, 1).translate(0, 6.2, 0);
    const trunkMat = this.mat({ color: type === 'palm' ? 0x8a7458 : 0x5b4532, roughness: 1 });
    const crownMat = this.mat({ color: 0xffffff, roughness: 0.95, flatShading: true });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, positions.length);
    const base = type === 'palm' ? new THREE.Color('#4f7a2c') : type === 'pine' ? new THREE.Color('#2f5a2c') : new THREE.Color('#4a7a30');
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    positions.forEach((p, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.r);
      m.compose(new THREE.Vector3(p.x, p.y - 0.2, p.z), q, new THREE.Vector3(p.s, p.s * (0.85 + (i % 5) * 0.08), p.s));
      trunks.setMatrixAt(i, m);
      crowns.setMatrixAt(i, m);
      c.copy(base).offsetHSL((this.rng() - 0.5) * 0.06, (this.rng() - 0.5) * 0.15, (this.rng() - 0.5) * 0.12);
      if (type === 'mixed' && i % 3 === 0) c.set('#8c5a2b').offsetHSL(0, 0, (this.rng() - 0.5) * 0.1);
      crowns.setColorAt(i, c);
    });
    const shadows = this.quality === 'high';
    trunks.castShadow = shadows;
    crowns.castShadow = shadows;
    this.group.add(trunks, crowns);
    this.disposables.push(trunkGeo, crownGeo);
  }

  private buildMountains(): void {
    if (!this.env.mountains) return;
    const geos: THREE.BufferGeometry[] = [];
    const R = this.radius + 1800;
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2 + this.rng() * 0.3;
      const r = R + this.rng() * 1200;
      const h = 180 + this.rng() * 420;
      const g = new THREE.ConeGeometry(500 + this.rng() * 600, h, 7, 1);
      g.translate(this.center.x + Math.sin(a) * r, this.track.minY + h / 2 - 20, this.center.z + Math.cos(a) * r);
      geos.push(g);
    }
    const col = new THREE.Color(this.env.hemiGround).lerp(new THREE.Color(this.env.fog), 0.35);
    this.add(mergeGeometries(geos)!, this.mat({ color: col, roughness: 1, flatShading: true }), { receive: false });
  }

  /** Wahrzeichen: Riesenrad (Suzuka), Aussichtsturm (COTA). */
  private buildLandmarks(): void {
    const tr = this.track;
    const id = tr.def.id;
    if (id !== 'suzuka' && id !== 'cota') return;
    // Platz suchen
    let best: { x: number; z: number } | null = null;
    for (let k = 0; k < 400 && !best; k++) {
      const x = this.center.x + (this.rng() - 0.5) * (tr.maxX - tr.minX) * 0.8;
      const z = this.center.z + (this.rng() - 0.5) * (tr.maxZ - tr.minZ) * 0.8;
      const nr = tr.nearest(x, z, 200);
      if (nr.i >= 0 && nr.dist > 90 && nr.dist < 180) best = { x, z };
    }
    if (!best || !this.terrainH) return;
    const y = this.terrainH(best.x, best.z);
    const g = new THREE.Group();
    g.position.set(best.x, y, best.z);
    if (id === 'suzuka') {
      const mat = this.mat({ color: 0xf2f2f2, roughness: 0.5, metalness: 0.3 });
      const wheel = new THREE.Mesh(new THREE.TorusGeometry(28, 0.8, 6, 48), mat);
      wheel.position.y = 34;
      g.add(wheel);
      for (let k = 0; k < 16; k++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.4, 56, 0.4), mat);
        spoke.position.y = 34;
        spoke.rotation.z = (k / 16) * Math.PI;
        g.add(spoke);
        const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), this.mat({ color: new THREE.Color().setHSL(k / 16, 0.7, 0.55) }));
        const a = (k / 16) * Math.PI * 2;
        cab.position.set(Math.sin(a) * 28, 34 + Math.cos(a) * 28, 0);
        g.add(cab);
      }
      for (const x of [-10, 10]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 36, 1), mat);
        leg.position.set(x * 0.4, 17, 0);
        leg.rotation.z = x > 0 ? -0.28 : 0.28;
        g.add(leg);
      }
    } else {
      const red = this.mat({ color: 0xc8102e, roughness: 0.5, metalness: 0.3 });
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.6, 76, 0.6), red);
        strut.position.set(Math.sin(a) * 5, 38, Math.cos(a) * 5);
        strut.rotation.set(Math.cos(a) * 0.08, 0, -Math.sin(a) * 0.08);
        g.add(strut);
      }
      const deck = new THREE.Mesh(new THREE.CylinderGeometry(8, 6, 4, 16), this.mat({ color: 0x2a2f38, roughness: 0.3, metalness: 0.6 }));
      deck.position.y = 72;
      g.add(deck);
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = this.quality === 'high';
    });
    this.group.add(g);
  }

  // ---------------------------------------------------------------- Laufzeit

  terrainHeight(x: number, z: number): number {
    return this.terrainH ? this.terrainH(x, z) : this.track.minY;
  }

  /** Schatten-Kamera dem Ziel folgen lassen. */
  updateSun(target: THREE.Vector3): void {
    const d = 260;
    this.sun.position.set(target.x + this.sunDir.x * d, target.y + this.sunDir.y * d, target.z + this.sunDir.z * d);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.time += dt;
    this.sky.position.copy(camPos);
    if (this.hotelMat) {
      const h = (this.time * 0.05) % 1;
      this.hotelMat.emissive.setHSL(h, 0.8, 0.5);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.group.clear();
  }
}
