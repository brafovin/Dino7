// 3D-Hintergrund für die Menüs: Fahrzeug auf Drehteller mit Lichtakzenten.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { Driver, Team } from '../shared/teams';
import { buildCar, type CarMeshParts } from './CarModel';
import type { Renderer } from './Renderer';

export class Showroom {
  readonly scene = new THREE.Scene();
  private car: CarMeshParts | null = null;
  private carKey = '';
  private readonly turntable = new THREE.Group();
  private readonly spots: THREE.SpotLight[] = [];
  private readonly accent: THREE.PointLight;
  private t = 0;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private stripes: THREE.Mesh[] = [];

  constructor(renderer: Renderer) {
    const s = this.scene;
    s.background = new THREE.Color('#05070b');
    s.fog = new THREE.Fog('#05070b', 18, 46);
    try {
      const pmrem = new THREE.PMREMGenerator(renderer.gl);
      this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      s.environment = this.envRT.texture;
      s.environmentIntensity = 0.55;
      pmrem.dispose();
    } catch {
      /* optional */
    }
    // Boden
    const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 64), new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.22, metalness: 0.6 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    // Drehteller
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.3, 0.12, 64), new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.35, metalness: 0.7 }));
    disc.position.y = 0.06;
    disc.receiveShadow = true;
    this.turntable.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(4.25, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: 0xe8002d }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.125;
    this.turntable.add(ring);
    s.add(this.turntable);
    // Lichtstreifen im Hintergrund
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 9), new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0xe8002d : 0x3a4458, transparent: true, opacity: 0.55 }));
      const a = -0.9 + (i / 8) * 1.8;
      m.position.set(Math.sin(a) * 16, 4.2, -Math.cos(a) * 16);
      m.lookAt(0, 4.2, 0);
      s.add(m);
      this.stripes.push(m);
    }
    s.add(new THREE.HemisphereLight(0x9fb2d6, 0x08090c, 0.35));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(5, 9, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -6;
    s.add(key);
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.SpotLight(i === 1 ? 0xff2a4a : 0xffffff, 60, 30, 0.35, 0.6, 1.6);
      sp.position.set((i - 1) * 7, 8, 4);
      sp.target.position.set(0, 0, 0);
      s.add(sp, sp.target);
      this.spots.push(sp);
    }
    this.accent = new THREE.PointLight(0xe8002d, 12, 12, 1.5);
    this.accent.position.set(-3, 1.2, -3);
    s.add(this.accent);
  }

  setCar(team: Team, driver: Driver): void {
    const key = `${team.id}-${driver.id}`;
    if (key === this.carKey) return;
    this.carKey = key;
    if (this.car) this.turntable.remove(this.car.root);
    this.car = buildCar(team, driver, 2);
    this.car.root.position.y = 0.12;
    this.car.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    this.turntable.add(this.car.root);
    (this.accent.color as THREE.Color).set(team.livery.primary);
    this.spots[1].color.set(team.livery.primary);
  }

  update(dt: number, cam: THREE.PerspectiveCamera, aspect: number): void {
    this.t += dt;
    this.turntable.rotation.y += dt * 0.25;
    this.spots.forEach((sp, i) => {
      sp.target.position.set(Math.sin(this.t * 0.6 + i * 2) * 2.2, 0, Math.cos(this.t * 0.45 + i) * 2.2);
      sp.target.updateMatrixWorld();
    });
    this.accent.position.set(Math.sin(this.t * 0.7) * 5, 1.4, Math.cos(this.t * 0.7) * 5);
    this.stripes.forEach((m, i) => ((m.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.3 * Math.sin(this.t * 1.3 + i)));
    // Auto rechts im Bild bei breiten Bildschirmen
    const offX = aspect > 1.2 ? -2.6 : 0;
    cam.position.set(7.2 + offX * 0.2, 2.3, 7.8);
    cam.lookAt(offX, 0.6, 0);
    if (cam.fov !== 40) {
      cam.fov = 40;
      cam.updateProjectionMatrix();
    }
    if (this.car) {
      for (const w of this.car.wheels) w.spin.rotation.x = 0;
    }
  }

  dispose(): void {
    this.envRT?.dispose();
    this.scene.clear();
  }
}
