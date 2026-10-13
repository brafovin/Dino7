// Prozedurales 3D-Modell eines Formel-Rennwagens mit Team-Lackierung.
// Lokales System: +Z vorne, +X links, +Y oben; Ursprung am Boden unter dem Schwerpunkt.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COMPOUNDS, type Compound } from '../shared/carPhysics';
import type { Driver, Team } from '../shared/teams';
import { helmetTexture } from './textures';

const FRONT_AXLE = 1.98;
const REAR_AXLE = -1.62;
const WHEEL_R = 0.36;
const HALF_TRACK_F = 0.8;
const HALF_TRACK_R = 0.78;

interface Section {
  z: number;
  x?: number;
  y: number;
  w: number;
  h: number;
  n?: number;
}

type ColorFn = (x: number, y: number, z: number, out: THREE.Color) => void;

const tmpC = new THREE.Color();

/** Loft durch Superellipsen-Querschnitte entlang Z. */
function loft(sections: Section[], seg: number, color: ColorFn, caps = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const rings: [number, number, number][][] = [];
  for (const s of sections) {
    const ring: [number, number, number][] = [];
    const n = s.n ?? 2.6;
    for (let i = 0; i < seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const c = Math.cos(t);
      const si = Math.sin(t);
      const x = (s.x ?? 0) + (s.w / 2) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
      const y = s.y + (s.h / 2) * Math.sign(si) * Math.pow(Math.abs(si), 2 / n);
      ring.push([x, y, s.z]);
    }
    rings.push(ring);
  }
  const push = (p: [number, number, number]) => {
    pos.push(p[0], p[1], p[2]);
    color(p[0], p[1], p[2], tmpC);
    col.push(tmpC.r, tmpC.g, tmpC.b);
  };
  for (let r = 0; r < rings.length - 1; r++) {
    const a = rings[r];
    const b = rings[r + 1];
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      // Orientierung: Normalen nach außen bei Ringfolge mit abnehmendem z umgekehrt
      if (sections[r + 1].z < sections[r].z) {
        push(a[i]);
        push(b[i]);
        push(b[j]);
        push(a[i]);
        push(b[j]);
        push(a[j]);
      } else {
        push(a[i]);
        push(b[j]);
        push(b[i]);
        push(a[i]);
        push(a[j]);
        push(b[j]);
      }
    }
  }
  if (caps) {
    for (const [ri, flip] of [
      [0, true],
      [rings.length - 1, false],
    ] as [number, boolean][]) {
      const ring = rings[ri];
      const c: [number, number, number] = [0, 0, 0];
      for (const p of ring) {
        c[0] += p[0] / seg;
        c[1] += p[1] / seg;
        c[2] += p[2] / seg;
      }
      const dec = sections[sections.length - 1].z < sections[0].z;
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        if (flip !== dec) {
          push(c);
          push(ring[j]);
          push(ring[i]);
        } else {
          push(c);
          push(ring[i]);
          push(ring[j]);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function colored(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation | ColorFn): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const p = g.getAttribute('position');
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    if (typeof color === 'function') color(p.getX(i), p.getY(i), p.getZ(i), c);
    else c.set(color);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: THREE.ColorRepresentation | ColorFn, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.rotateX(rx).rotateY(ry).rotateZ(rz);
  g.translate(x, y, z);
  return colored(g, color);
}

function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 6, 1);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate(mid.x, mid.y, mid.z);
  return colored(g, color);
}

/** Flügelelement: Profil in (z,y), Spannweite entlang X. */
function wing(span: number, chord: number, thick: number, camber: number, angle: number, cx: number, cy: number, cz: number, color: THREE.ColorRepresentation | ColorFn): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  const N = 8;
  const top: [number, number][] = [];
  const bot: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const camb = camber * Math.sin(u * Math.PI);
    const th = thick * (u < 0.3 ? Math.sqrt(u / 0.3) : 1 - (u - 0.3) / 0.75) * 0.5;
    top.push([u * chord - chord / 2, camb + Math.max(0.002, th)]);
    bot.push([u * chord - chord / 2, camb - Math.max(0.002, th * 0.6)]);
  }
  sh.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i < top.length; i++) sh.lineTo(top[i][0], top[i][1]);
  for (let i = bot.length - 1; i >= 0; i--) sh.lineTo(bot[i][0], bot[i][1]);
  const g = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, -span / 2);
  // Profil-X (Sehne) -> Fahrzeug-Z (Vorderkante vorne = +Z), Extrusion -> Fahrzeug-X
  g.rotateY(-Math.PI / 2);
  g.rotateX(angle);
  g.translate(cx, cy, cz);
  return colored(g, color);
}

function plateShape(points: [number, number][], thick: number, x: number, color: THREE.ColorRepresentation | ColorFn): THREE.BufferGeometry {
  // Polygon in (z,y), Dicke entlang X
  const sh = new THREE.Shape();
  sh.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) sh.lineTo(points[i][0], points[i][1]);
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateY(-Math.PI / 2);
  g.translate(x, 0, 0);
  return colored(g, color);
}

interface Palette {
  p: THREE.Color;
  s: THREE.Color;
  a: THREE.Color;
  carbon: THREE.Color;
}

function bodyColor(team: Team, pal: Palette): ColorFn {
  const pat = team.livery.pattern;
  return (x, y, z, out) => {
    out.copy(pal.p);
    switch (pat) {
      case 'stripe':
        if (Math.abs(x) < 0.07 && y > 0.42) out.copy(pal.s);
        if (z > 2.55) out.copy(pal.a);
        break;
      case 'split':
        if (y < 0.36 + z * 0.02) out.copy(pal.s);
        if (z > 2.6) out.copy(pal.a);
        break;
      case 'arrow': {
        const zz = z + Math.abs(y - 0.45) * 1.6;
        if (zz > 0.1 && zz < 0.55 && Math.abs(x) > 0.2) out.copy(pal.s);
        if (z > 2.45) out.copy(pal.a);
        if (y < 0.25) out.copy(pal.s);
        break;
      }
      case 'fade': {
        const t = THREE.MathUtils.smoothstep(z, 0.6, -1.4);
        out.copy(pal.p).lerp(pal.s, t);
        if (z > 2.6) out.copy(pal.a);
        break;
      }
      case 'band':
        if (z > -0.35 && z < 0.25) out.copy(pal.s);
        if (z > 2.6) out.copy(pal.a);
        if (y < 0.22) out.copy(pal.carbon);
        break;
    }
  };
}

export interface CarMeshParts {
  root: THREE.Group;
  body: THREE.Group;
  wheels: { pivot: THREE.Object3D; spin: THREE.Object3D; front: boolean }[];
  brakeMat: THREE.MeshStandardMaterial;
  sidewallMats: THREE.MeshStandardMaterial[];
  helmet: THREE.Mesh;
}

const geoCache = new Map<string, THREE.BufferGeometry>();
let sharedMats: {
  body: THREE.MeshStandardMaterial;
  carbon: THREE.MeshStandardMaterial;
  tyre: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
} | null = null;

function mats() {
  if (!sharedMats) {
    sharedMats = {
      body: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.32, envMapIntensity: 1.0 }),
      carbon: new THREE.MeshStandardMaterial({ color: 0x151618, metalness: 0.2, roughness: 0.55 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x141416, metalness: 0, roughness: 0.92 }),
      rim: new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.75, roughness: 0.35 }),
    };
  }
  return sharedMats;
}

function buildBodyGeometry(team: Team, detail: number): THREE.BufferGeometry {
  const key = `${team.id}-${detail}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const pal: Palette = {
    p: new THREE.Color(team.livery.primary),
    s: new THREE.Color(team.livery.secondary),
    a: new THREE.Color(team.livery.accent),
    carbon: new THREE.Color(team.livery.carbon),
  };
  const body = bodyColor(team, pal);
  const carbon = pal.carbon;
  const seg = detail > 1 ? 20 : 12;
  const parts: THREE.BufferGeometry[] = [];

  // Nase + Monocoque
  parts.push(
    loft(
      [
        { z: 3.0, y: 0.2, w: 0.14, h: 0.1 },
        { z: 2.7, y: 0.25, w: 0.22, h: 0.15 },
        { z: 2.3, y: 0.32, w: 0.3, h: 0.22 },
        { z: 1.8, y: 0.39, w: 0.38, h: 0.29 },
        { z: 1.2, y: 0.45, w: 0.5, h: 0.37 },
        { z: 0.6, y: 0.49, w: 0.66, h: 0.44 },
        { z: 0.0, y: 0.5, w: 0.8, h: 0.5 },
        { z: -0.45, y: 0.53, w: 0.82, h: 0.56 },
      ],
      seg,
      body,
    ),
  );
  // Motorabdeckung
  parts.push(
    loft(
      [
        { z: -0.4, y: 0.6, w: 0.78, h: 0.62 },
        { z: -1.0, y: 0.58, w: 0.62, h: 0.56 },
        { z: -1.6, y: 0.5, w: 0.42, h: 0.44 },
        { z: -2.15, y: 0.43, w: 0.24, h: 0.3 },
        { z: -2.45, y: 0.4, w: 0.12, h: 0.18 },
      ],
      seg,
      body,
    ),
  );
  // Airbox / Überrollbügel
  parts.push(
    loft(
      [
        { z: -0.12, y: 0.95, w: 0.2, h: 0.2, n: 3 },
        { z: -0.35, y: 0.93, w: 0.3, h: 0.26, n: 3 },
        { z: -0.7, y: 0.84, w: 0.3, h: 0.3, n: 3 },
        { z: -1.1, y: 0.72, w: 0.22, h: 0.3, n: 3 },
      ],
      seg,
      body,
    ),
  );
  // Ansaugöffnung
  parts.push(box(0.14, 0.12, 0.02, 0, 0.96, -0.11, 0x050505));
  // Haifischflosse
  parts.push(
    plateShape(
      [
        [-0.75, 0.92],
        [-2.25, 0.86],
        [-2.25, 0.6],
        [-0.9, 0.7],
      ],
      0.015,
      0,
      (_x, y, z, out) => out.copy(z < -1.6 && y > 0.7 ? pal.a : pal.s),
    ),
  );
  // Seitenkästen (flach, mit Taille nach hinten)
  for (const side of [1, -1]) {
    parts.push(
      loft(
        [
          { z: 0.66, x: side * 0.56, y: 0.35, w: 0.3, h: 0.26, n: 2.2 },
          { z: 0.5, x: side * 0.6, y: 0.36, w: 0.4, h: 0.33, n: 2.4 },
          { z: 0.0, x: side * 0.6, y: 0.35, w: 0.42, h: 0.34, n: 2.4 },
          { z: -0.6, x: side * 0.52, y: 0.31, w: 0.34, h: 0.28, n: 2.3 },
          { z: -1.2, x: side * 0.4, y: 0.25, w: 0.22, h: 0.18, n: 2.2 },
          { z: -1.7, x: side * 0.28, y: 0.21, w: 0.1, h: 0.08, n: 2.2 },
        ],
        seg,
        body,
      ),
    );
    // Kühlöffnung
    parts.push(box(0.24, 0.2, 0.02, side * 0.57, 0.36, 0.67, 0x050506));
    // Spiegel
    parts.push(box(0.14, 0.07, 0.04, side * 0.5, 0.72, 0.45, body));
    parts.push(rod(new THREE.Vector3(side * 0.3, 0.6, 0.5), new THREE.Vector3(side * 0.47, 0.71, 0.45), 0.01, carbon));
  }
  // Cockpit-Öffnung
  parts.push(
    loft(
      [
        { z: 0.55, y: 0.74, w: 0.36, h: 0.04 },
        { z: 0.2, y: 0.76, w: 0.5, h: 0.04 },
        { z: -0.2, y: 0.78, w: 0.46, h: 0.04 },
        { z: -0.32, y: 0.79, w: 0.3, h: 0.04 },
      ],
      seg,
      () => tmpC.set(0x08090b),
    ),
  );
  // Unterboden + Diffusor
  {
    const sh = new THREE.Shape();
    sh.moveTo(0.42, 1.25);
    sh.lineTo(0.85, 0.7);
    sh.lineTo(0.88, -1.4);
    sh.lineTo(0.62, -2.0);
    sh.lineTo(-0.62, -2.0);
    sh.lineTo(-0.88, -1.4);
    sh.lineTo(-0.85, 0.7);
    sh.lineTo(-0.42, 1.25);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.04, bevelEnabled: false });
    g.rotateX(Math.PI / 2);
    g.translate(0, 0.085, 0);
    parts.push(colored(g, carbon));
    parts.push(box(1.1, 0.02, 0.5, 0, 0.12, -2.2, carbon, -0.35));
    for (const side of [1, -1]) parts.push(box(0.02, 0.18, 0.5, side * 0.55, 0.15, -2.2, carbon));
  }
  // Halo
  {
    const pts = [
      new THREE.Vector3(0.37, 0.72, -0.34),
      new THREE.Vector3(0.39, 0.88, -0.12),
      new THREE.Vector3(0.3, 0.94, 0.16),
      new THREE.Vector3(0.0, 0.96, 0.34),
      new THREE.Vector3(-0.3, 0.94, 0.16),
      new THREE.Vector3(-0.39, 0.88, -0.12),
      new THREE.Vector3(-0.37, 0.72, -0.34),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    parts.push(colored(new THREE.TubeGeometry(curve, detail > 1 ? 24 : 12, 0.026, 6, false), carbon));
    parts.push(rod(new THREE.Vector3(0, 0.95, 0.34), new THREE.Vector3(0, 0.66, 0.66), 0.03, carbon));
  }
  // Frontflügel
  {
    const span = 1.9;
    parts.push(wing(span, 0.32, 0.03, 0.02, 0.05, 0, 0.09, 2.78, carbon));
    parts.push(wing(span * 0.92, 0.18, 0.02, 0.015, -0.35, 0, 0.16, 2.6, (x, _y, _z, o) => o.copy(Math.abs(x) > 0.55 ? pal.s : carbon)));
    parts.push(wing(span * 0.86, 0.14, 0.016, 0.012, -0.6, 0, 0.23, 2.5, (x, _y, _z, o) => o.copy(Math.abs(x) > 0.5 ? pal.a : pal.p)));
    for (const side of [1, -1]) {
      parts.push(
        plateShape(
          [
            [2.98, 0.04],
            [2.98, 0.2],
            [2.75, 0.3],
            [2.35, 0.3],
            [2.35, 0.04],
          ],
          0.02,
          side * 0.96,
          pal.s,
        ),
      );
    }
    // Nasenaufhängung
    parts.push(box(0.04, 0.12, 0.25, 0.1, 0.16, 2.72, carbon));
    parts.push(box(0.04, 0.12, 0.25, -0.1, 0.16, 2.72, carbon));
  }
  // Heckflügel
  {
    parts.push(wing(1.0, 0.36, 0.05, 0.04, 0.12, 0, 0.82, -2.48, pal.s));
    parts.push(wing(0.98, 0.2, 0.025, 0.02, -0.45, 0, 0.93, -2.62, (x, _y, _z, o) => o.copy(Math.abs(x) > 0.4 ? pal.a : pal.p)));
    parts.push(wing(0.9, 0.16, 0.02, 0.01, 0.15, 0, 0.45, -2.4, carbon));
    for (const side of [1, -1]) {
      parts.push(
        plateShape(
          [
            [-2.25, 0.42],
            [-2.25, 0.98],
            [-2.75, 1.0],
            [-2.8, 0.55],
            [-2.55, 0.4],
          ],
          0.02,
          side * 0.51,
          pal.p,
        ),
      );
    }
    parts.push(box(0.03, 0.3, 0.06, 0, 0.75, -2.3, carbon, 0.3));
    // Crash-Struktur
    parts.push(box(0.16, 0.14, 0.4, 0, 0.36, -2.45, carbon));
  }
  // Aufhängung (statisch)
  for (const side of [1, -1]) {
    const fh = new THREE.Vector3(side * HALF_TRACK_F, WHEEL_R, FRONT_AXLE);
    const rh = new THREE.Vector3(side * HALF_TRACK_R, WHEEL_R, REAR_AXLE);
    parts.push(rod(new THREE.Vector3(side * 0.2, 0.45, FRONT_AXLE + 0.25), fh.clone().add(new THREE.Vector3(-side * 0.1, 0.08, 0)), 0.018, carbon));
    parts.push(rod(new THREE.Vector3(side * 0.2, 0.45, FRONT_AXLE - 0.3), fh.clone().add(new THREE.Vector3(-side * 0.1, 0.08, 0)), 0.018, carbon));
    parts.push(rod(new THREE.Vector3(side * 0.2, 0.28, FRONT_AXLE + 0.25), fh.clone().add(new THREE.Vector3(-side * 0.1, -0.08, 0)), 0.018, carbon));
    parts.push(rod(new THREE.Vector3(side * 0.2, 0.28, FRONT_AXLE - 0.35), fh.clone().add(new THREE.Vector3(-side * 0.1, -0.08, 0)), 0.018, carbon));
    parts.push(rod(new THREE.Vector3(side * 0.25, 0.42, REAR_AXLE + 0.35), rh.clone().add(new THREE.Vector3(-side * 0.1, 0.1, 0)), 0.02, carbon));
    parts.push(rod(new THREE.Vector3(side * 0.25, 0.25, REAR_AXLE + 0.4), rh.clone().add(new THREE.Vector3(-side * 0.1, -0.08, 0)), 0.02, carbon));
    parts.push(rod(new THREE.Vector3(side * 0.15, 0.3, REAR_AXLE - 0.3), rh.clone().add(new THREE.Vector3(-side * 0.1, 0, 0)), 0.02, carbon));
  }
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Fahrzeuggeometrie konnte nicht erstellt werden');
  merged.computeBoundingSphere();
  for (const p of parts) p.dispose();
  geoCache.set(key, merged);
  return merged;
}

function tyreGeometry(width: number, detail: number): THREE.BufferGeometry {
  const key = `tyre${width}-${detail}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const hw = width / 2;
  const pts = [
    new THREE.Vector2(0.235, -hw),
    new THREE.Vector2(0.33, -hw),
    new THREE.Vector2(0.352, -hw + 0.025),
    new THREE.Vector2(WHEEL_R, -hw + 0.06),
    new THREE.Vector2(WHEEL_R, hw - 0.06),
    new THREE.Vector2(0.352, hw - 0.025),
    new THREE.Vector2(0.33, hw),
    new THREE.Vector2(0.235, hw),
  ];
  const g = new THREE.LatheGeometry(pts, detail > 1 ? 28 : 16);
  g.rotateZ(Math.PI / 2);
  geoCache.set(key, g);
  return g;
}

function sideDiscGeometry(width: number): THREE.BufferGeometry {
  const key = `disc${width}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const a = new THREE.CircleGeometry(0.335, 24);
  a.rotateY(Math.PI / 2);
  a.translate(width / 2 + 0.002, 0, 0);
  const b = new THREE.CircleGeometry(0.335, 24);
  b.rotateY(-Math.PI / 2);
  b.translate(-width / 2 - 0.002, 0, 0);
  const g = mergeGeometries([a, b], false)!;
  geoCache.set(key, g);
  return g;
}

function sidewallTextureFor(compound: Compound, accent: string): THREE.Texture {
  const key = `sw-${compound}-${accent}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#141518';
  ctx.fillRect(0, 0, 256, 256);
  // Felge mit Speichen
  ctx.fillStyle = '#30343a';
  ctx.beginPath();
  ctx.arc(128, 128, 88, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#8a929c';
  for (let k = 0; k < 10; k++) {
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate((k / 10) * Math.PI * 2);
    ctx.fillRect(-5, 14, 10, 70);
    ctx.restore();
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(128, 128, 84, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#16181c';
  ctx.beginPath();
  ctx.arc(128, 128, 16, 0, Math.PI * 2);
  ctx.fill();
  // Mischungsring + Schrift
  ctx.strokeStyle = COMPOUNDS[compound].color;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(128, 128, 108, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#e6e6e6';
  ctx.font = 'bold 15px Arial';
  ctx.textAlign = 'center';
  for (let k = 0; k < 2; k++) {
    ctx.save();
    ctx.translate(128, 128);
    ctx.rotate(k * Math.PI);
    ctx.fillText('APEX', 0, -116);
    ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

const texCache = new Map<string, THREE.Texture>();

function decalTexture(driver: Driver, team: Team): THREE.Texture {
  const key = `decal-${driver.id}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 128);
  // links: Startnummer (128x128)
  ctx.font = 'italic 900 92px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 9;
  ctx.strokeStyle = team.livery.secondary;
  ctx.strokeText(String(driver.number), 64, 68);
  ctx.fillStyle = team.livery.accent;
  ctx.fillText(String(driver.number), 64, 68);
  // rechts: Teamname
  ctx.font = 'italic 900 64px Arial, sans-serif';
  ctx.fillStyle = team.livery.accent;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4;
  ctx.strokeText(team.name.toUpperCase(), 320, 68, 370);
  ctx.fillText(team.name.toUpperCase(), 320, 68, 370);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

function decalQuad(w: number, h: number, u0: number, u1: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) < 0.5 ? u0 : u1);
  return g;
}

/** Baut ein Fahrzeug für Fahrer/Team. detail: 1 = niedrig, 2 = hoch. */
export function buildCar(team: Team, driver: Driver, detail = 2, compound: Compound = 'medium'): CarMeshParts {
  const m = mats();
  const root = new THREE.Group();
  root.name = `car-${driver.code}`;
  const body = new THREE.Group();
  root.add(body);
  const bodyMesh = new THREE.Mesh(buildBodyGeometry(team, detail), m.body);
  bodyMesh.castShadow = true;
  body.add(bodyMesh);

  // Decals (Nummer auf Nase und Flosse, Teamname auf der Motorabdeckung)
  const decalMat = new THREE.MeshStandardMaterial({ map: decalTexture(driver, team), transparent: true, roughness: 0.4, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  const decals: THREE.BufferGeometry[] = [];
  const nose = decalQuad(0.2, 0.2, 0, 0.25);
  nose.rotateX(-Math.PI / 2 + 0.2);
  nose.translate(0, 0.5, 1.95);
  decals.push(nose);
  for (const side of [1, -1]) {
    const fin = decalQuad(0.36, 0.36, 0, 0.25);
    fin.rotateY(side * Math.PI / 2);
    fin.translate(side * 0.011, 0.78, -1.45);
    decals.push(fin);
    const name = decalQuad(0.62, 0.155, 0.25, 1);
    name.rotateY(side * Math.PI / 2);
    name.rotateX(0);
    name.translate(side * 0.335, 0.6, -0.95);
    decals.push(name);
  }
  const decalMesh = new THREE.Mesh(mergeGeometries(decals, false)!, decalMat);
  body.add(decalMesh);

  // Helm
  const [h1, h2, h3] = driver.helmet;
  const helmetMat = new THREE.MeshStandardMaterial({ map: helmetTexture(h1, h2, h3, driver.number), roughness: 0.25, metalness: 0.2 });
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 18, 12), helmetMat);
  helmet.scale.set(1, 1.02, 1.12);
  helmet.rotation.y = Math.PI;
  helmet.position.set(0, 0.84, -0.04);
  helmet.castShadow = true;
  body.add(helmet);
  // T-Kamera (Fahrer 1 schwarz, Fahrer 2 gelb)
  const tcam = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.08), new THREE.MeshStandardMaterial({ color: team.drivers[0]?.id === driver.id ? 0x111111 : 0xffd400, roughness: 0.4 }));
  tcam.position.set(0, 1.08, -0.3);
  body.add(tcam);

  // Regen-/Bremslicht
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1010, emissiveIntensity: 0.3, roughness: 0.4 });
  const light = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.03), brakeMat);
  light.position.set(0, 0.36, -2.66);
  body.add(light);
  for (const side of [1, -1]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.25, 0.02), brakeMat);
    strip.position.set(side * 0.52, 0.72, -2.79);
    body.add(strip);
  }

  // Räder
  const wheels: CarMeshParts['wheels'] = [];
  const sidewallMats: THREE.MeshStandardMaterial[] = [];
  const configs: [number, number, number, boolean][] = [
    [HALF_TRACK_F, FRONT_AXLE, 0.3, true],
    [-HALF_TRACK_F, FRONT_AXLE, 0.3, true],
    [HALF_TRACK_R, REAR_AXLE, 0.4, false],
    [-HALF_TRACK_R, REAR_AXLE, 0.4, false],
  ];
  for (const [x, z, width, front] of configs) {
    const pivot = new THREE.Object3D();
    pivot.position.set(x, WHEEL_R, z);
    const spin = new THREE.Object3D();
    pivot.add(spin);
    const tyre = new THREE.Mesh(tyreGeometry(width, detail), m.tyre);
    tyre.castShadow = true;
    spin.add(tyre);
    const swMat = new THREE.MeshStandardMaterial({ map: sidewallTextureFor(compound, team.livery.accent), roughness: 0.7, metalness: 0.2 });
    sidewallMats.push(swMat);
    const disc = new THREE.Mesh(sideDiscGeometry(width), swMat);
    spin.add(disc);
    root.add(pivot);
    wheels.push({ pivot, spin, front });
  }
  return { root, body, wheels, brakeMat, sidewallMats, helmet };
}

/** Wechselt die Reifenmarkierung (nach Boxenstopp). */
export function setCarCompound(parts: CarMeshParts, team: Team, compound: Compound): void {
  for (const m of parts.sidewallMats) {
    m.map = sidewallTextureFor(compound, team.livery.accent);
    m.needsUpdate = true;
  }
}

export function disposeCarCaches(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
  for (const t of texCache.values()) t.dispose();
  texCache.clear();
}

export const CAR_DIMS = { FRONT_AXLE, REAR_AXLE, WHEEL_R };
