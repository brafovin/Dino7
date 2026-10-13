// Fahrerfigur für die Siegerehrung: Rennanzug in Teamfarben (Streifen, Gürtel, Kragen, Aufnäher,
// Startnummer), Gelenke an Schulter, Ellbogen, Hüfte und Knie, Kopf mit Teamkappe und Sonnenbrille.
import * as THREE from 'three';
import type { Driver, Team } from '../shared/teams';

export interface ArmRig {
  shoulder: THREE.Group;
  elbow: THREE.Group;
  hand: THREE.Object3D;
  side: -1 | 1;
}

export interface LegRig {
  hip: THREE.Group;
  knee: THREE.Group;
}

/** Hauttöne / Haarfarben (stilisiert, Standard für alle nicht aufgeführten Fahrer) */
const SKIN_DEFAULT = '#e7b998';
const SKIN: Record<string, string> = {
  hamilton: '#8a5a3f',
  albon: '#d2a07a',
  perez: '#c99470',
  hadjar: '#d3a07c',
  bortoleto: '#dcab88',
  colapinto: '#dfae8a',
  sainz: '#dfae8b',
  alonso: '#d9a684',
  leclerc: '#e3b493',
};
const HAIR_DEFAULT = '#3a2a1f';
const HAIR: Record<string, string> = {
  hamilton: '#1a1410',
  bottas: '#c9a86a',
  hulkenberg: '#b8945c',
  verstappen: '#6a4a2e',
  piastri: '#4a3424',
  norris: '#5a3d26',
  lindblad: '#7a5636',
};

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Anzug-Oberteil (Lathe-UV: u = 0 vorne Mitte, 0.5 hinten; v = 0 Taille, 1 Hals) */
function suitTexture(team: Team, driver: Driver): THREE.CanvasTexture {
  const prim = team.livery.primary;
  const sec = team.livery.secondary;
  const acc = team.livery.accent;
  return canvasTex(512, 256, (g) => {
    const W = 512;
    const H = 256;
    g.fillStyle = prim;
    g.fillRect(0, 0, W, H);
    // Seitenteile in der Zweitfarbe (u ≈ 0.25 / 0.75)
    g.fillStyle = sec;
    for (const u of [0.25, 0.75]) g.fillRect(u * W - 26, 0, 52, H);
    g.fillStyle = acc;
    for (const u of [0.25, 0.75]) g.fillRect(u * W - 30, 0, 5, H);
    // Gürtel (unten = Taille, Canvas ist auf v gespiegelt)
    g.fillStyle = sec;
    g.fillRect(0, H * (1 - 0.29), W, H * 0.06);
    // Reißverschluss vorne
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 0, 3, H * 0.71);
    g.fillRect(W - 3, 0, 3, H * 0.71);
    // Aufnäher (neutral, ohne echte Marken)
    const patch = (u: number, v: number, w: number, h: number, col: string) => {
      g.fillStyle = col;
      const x = u * W;
      g.fillRect(x - w / 2, (1 - v) * H - h / 2, w, h);
      if (x - w / 2 < 0) g.fillRect(x - w / 2 + W, (1 - v) * H - h / 2, w, h);
    };
    patch(0.06, 0.62, 34, 14, '#ffffff');
    patch(0.94, 0.62, 34, 14, '#ffffff');
    patch(0.07, 0.42, 28, 10, acc);
    patch(0.93, 0.42, 28, 10, '#f2f2f2');
    patch(0.5, 0.6, 90, 26, '#ffffff');
    // Startnummer auf der Brust (rechts) und groß auf dem Rücken
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'italic 900 26px system-ui, sans-serif';
    g.fillText(String(driver.number), 0.94 * W, (1 - 0.78) * H);
    g.fillStyle = prim;
    g.font = 'italic 900 22px system-ui, sans-serif';
    g.fillText(team.short.toUpperCase(), 0.5 * W, (1 - 0.6) * H);
  });
}

/** Kappe (Kugelkalotte: u = 0.25 vorne) */
function capTexture(team: Team): THREE.CanvasTexture {
  return canvasTex(256, 64, (g) => {
    g.fillStyle = team.livery.primary;
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = team.livery.secondary;
    g.fillRect(0, 54, 256, 10);
    // Frontlogo
    g.fillStyle = team.livery.secondary;
    g.fillRect(64 - 26, 22, 52, 22);
    g.fillStyle = team.livery.primary;
    g.font = '900 15px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(team.short.slice(0, 4).toUpperCase(), 64, 34);
  });
}

export class DriverFigure {
  readonly root = new THREE.Group();
  /** Oberkörper (Drehpunkt an der Taille) */
  readonly torso = new THREE.Group();
  readonly head = new THREE.Group();
  readonly armL: ArmRig;
  readonly armR: ArmRig;
  readonly legL: LegRig;
  readonly legR: LegRig;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(team: Team, driver: Driver) {
    const suitTex = suitTexture(team, driver);
    const capTex = capTexture(team);
    const suitMat = new THREE.MeshStandardMaterial({ map: suitTex, roughness: 0.72 });
    const limbMat = new THREE.MeshStandardMaterial({ color: team.livery.primary, roughness: 0.72 });
    const accentMat = new THREE.MeshStandardMaterial({ color: team.livery.secondary, roughness: 0.6 });
    const skinMat = new THREE.MeshStandardMaterial({ color: SKIN[driver.id] ?? SKIN_DEFAULT, roughness: 0.62 });
    const hairMat = new THREE.MeshStandardMaterial({ color: HAIR[driver.id] ?? HAIR_DEFAULT, roughness: 0.9 });
    const bootMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.45, metalness: 0.1 });
    const capMat = new THREE.MeshStandardMaterial({ map: capTex, roughness: 0.75 });
    const brimMat = new THREE.MeshStandardMaterial({ color: team.livery.primary, roughness: 0.7 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x07080a, roughness: 0.05, metalness: 0.9 });
    this.disposables.push(suitTex, capTex, suitMat, limbMat, accentMat, skinMat, hairMat, bootMat, capMat, brimMat, glassMat);
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      this.disposables.push(geo);
      return m;
    };

    // Beine
    const makeLeg = (side: -1 | 1): LegRig => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.095, 0.93, 0);
      this.root.add(hip);
      mesh(new THREE.CylinderGeometry(0.083, 0.062, 0.43, 16), limbMat, hip, 0, -0.215, 0);
      mesh(new THREE.BoxGeometry(0.014, 0.36, 0.05), accentMat, hip, side * 0.066, -0.21, 0);
      const knee = new THREE.Group();
      knee.position.y = -0.43;
      hip.add(knee);
      mesh(new THREE.SphereGeometry(0.063, 14, 10), limbMat, knee);
      mesh(new THREE.CylinderGeometry(0.061, 0.046, 0.36, 16), limbMat, knee, 0, -0.18, 0);
      mesh(new THREE.SphereGeometry(0.058, 12, 10).scale(1, 1.6, 1.05), limbMat, knee, 0, -0.12, -0.008);
      mesh(new THREE.BoxGeometry(0.012, 0.34, 0.044), accentMat, knee, side * 0.053, -0.2, 0);
      // Rennschuh: Sohle + Schaft
      mesh(new THREE.CapsuleGeometry(0.05, 0.16, 4, 10).rotateX(Math.PI / 2).scale(1.05, 0.85, 1), bootMat, knee, 0, -0.405, 0.045);
      mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.1, 12), bootMat, knee, 0, -0.36, 0);
      return { hip, knee };
    };
    this.legL = makeLeg(-1);
    this.legR = makeLeg(1);

    // Oberkörper (Lathe: Taille → Brust → Schultern), abgeflacht
    this.torso.position.y = 0.93;
    this.root.add(this.torso);
    // Punkte gleichmäßig in der Höhe (Lathe-v = Punktindex / 12): Schritt, Hüfte, Taille, Brust, Schultern
    const prof = [
      [0.0, -0.15],
      [0.118, -0.135],
      [0.152, -0.07],
      [0.146, 0.0],
      [0.148, 0.07],
      [0.156, 0.14],
      [0.168, 0.21],
      [0.18, 0.28],
      [0.188, 0.35],
      [0.19, 0.42],
      [0.172, 0.48],
      [0.115, 0.525],
      [0.0, 0.55],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    mesh(new THREE.LatheGeometry(prof, 32).scale(1, 1, 0.64), suitMat, this.torso);
    // Schultern, Kragen, Hals
    for (const side of [-1, 1]) mesh(new THREE.SphereGeometry(0.066, 14, 10), limbMat, this.torso, side * 0.19, 0.455, 0);
    mesh(new THREE.CylinderGeometry(0.062, 0.07, 0.05, 18), accentMat, this.torso, 0, 0.545, 0);
    mesh(new THREE.CylinderGeometry(0.046, 0.05, 0.1, 14), skinMat, this.torso, 0, 0.6, 0.004);

    // Kopf
    this.head.position.set(0, 0.64, 0.01);
    this.torso.add(this.head);
    const HS = new THREE.Vector3(0.86, 1.08, 0.98);
    mesh(new THREE.SphereGeometry(0.1, 24, 18).scale(HS.x, HS.y, HS.z), skinMat, this.head, 0, 0.1, 0);
    mesh(new THREE.SphereGeometry(0.072, 18, 12).scale(0.92, 0.8, 0.95), skinMat, this.head, 0, 0.045, 0.018);
    mesh(new THREE.ConeGeometry(0.015, 0.042, 10).rotateX(Math.PI / 2), skinMat, this.head, 0, 0.085, 0.1);
    for (const side of [-1, 1]) mesh(new THREE.SphereGeometry(0.022, 10, 8).scale(0.5, 1, 0.8), skinMat, this.head, side * 0.086, 0.095, -0.004);
    // Haare an Hinterkopf und Seiten
    mesh(new THREE.SphereGeometry(0.103, 22, 12, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, Math.PI * 0.3, Math.PI * 0.32).scale(HS.x, HS.y, HS.z), hairMat, this.head, 0, 0.1, 0);
    // Kappe mit Schirm
    mesh(new THREE.SphereGeometry(0.107, 26, 12, 0, Math.PI * 2, 0, Math.PI * 0.52).scale(0.9, 0.82, 1.0), capMat, this.head, 0, 0.118, -0.004);
    const brim = mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.009, 24, 1, false, -Math.PI / 2, Math.PI).scale(0.84, 1, 1.05), brimMat, this.head, 0, 0.122, 0.055);
    brim.rotation.x = 0.14;
    // Sonnenbrille
    mesh(new THREE.SphereGeometry(0.105, 22, 3, Math.PI / 2 - 0.85, 1.7, 1.33, 0.27).scale(HS.x, HS.y, HS.z), glassMat, this.head, 0, 0.1, 0.004);
    // Bügel der Sonnenbrille
    for (const side of [-1, 1]) mesh(new THREE.BoxGeometry(0.006, 0.008, 0.09), glassMat, this.head, side * 0.089, 0.112, -0.035);
    // Mund (leicht dunklerer Hautton)
    const lip = new THREE.MeshStandardMaterial({ color: new THREE.Color(SKIN[driver.id] ?? SKIN_DEFAULT).multiplyScalar(0.72), roughness: 0.5 });
    this.disposables.push(lip);
    mesh(new THREE.CapsuleGeometry(0.005, 0.026, 2, 6).rotateZ(Math.PI / 2), lip, this.head, 0, 0.038, 0.083);

    // Arme
    const makeArm = (side: -1 | 1): ArmRig => {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.205, 0.45, 0);
      this.torso.add(shoulder);
      mesh(new THREE.CylinderGeometry(0.054, 0.045, 0.3, 14), limbMat, shoulder, 0, -0.15, 0);
      const elbow = new THREE.Group();
      elbow.position.y = -0.3;
      shoulder.add(elbow);
      mesh(new THREE.SphereGeometry(0.046, 12, 10), limbMat, elbow);
      mesh(new THREE.CylinderGeometry(0.045, 0.036, 0.27, 14), limbMat, elbow, 0, -0.135, 0);
      mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.03, 12), accentMat, elbow, 0, -0.255, 0);
      const hand = new THREE.Group();
      hand.position.y = -0.29;
      elbow.add(hand);
      mesh(new THREE.CapsuleGeometry(0.03, 0.05, 4, 10).scale(1.15, 1, 0.62), skinMat, hand, 0, -0.045, 0);
      mesh(new THREE.CapsuleGeometry(0.012, 0.03, 3, 6), skinMat, hand, -side * 0.03, -0.035, 0.012).rotation.z = side * 0.5;
      const anchor = new THREE.Object3D();
      anchor.position.set(0, -0.06, 0.02);
      hand.add(anchor);
      return { shoulder, elbow, hand: anchor, side };
    };
    this.armL = makeArm(-1);
    this.armR = makeArm(1);
    this.setArm(this.armL, 0.12, 0.05, 0.25);
    this.setArm(this.armR, 0.12, 0.05, 0.25);
  }

  /**
   * Armhaltung. lift: seitliches Anheben in rad (0 = hängend, π = senkrecht nach oben, > π = nach innen),
   * fwd: nach vorne schwingen (bei hängendem Arm), bend: Ellbogen beugen (Unterarm nach vorne).
   */
  setArm(arm: ArmRig, lift: number, fwd: number, bend: number): void {
    arm.shoulder.rotation.set(-fwd, 0, arm.side * lift);
    arm.elbow.rotation.set(-bend, 0, 0);
  }

  /** Knie leicht beugen (Hüfte gleicht aus), Gewicht verlagern */
  setLegs(bendL: number, bendR: number): void {
    this.legL.hip.rotation.x = -bendL * 0.5;
    this.legL.knee.rotation.x = bendL;
    this.legR.hip.rotation.x = -bendR * 0.5;
    this.legR.knee.rotation.x = bendR;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
