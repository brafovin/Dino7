// WebGL-Renderer mit Qualitätsstufen und optionalem Bloom.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Quality } from '../settings';
import { setMaxAnisotropy } from './textures';

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  quality: Quality;
  private readonly container: HTMLElement;
  private readonly onResize = () => this.resize();

  constructor(container: HTMLElement, quality: Quality) {
    this.container = container;
    this.quality = quality;
    let gl: THREE.WebGLRenderer;
    try {
      gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    } catch (e) {
      throw new Error('WebGL konnte nicht initialisiert werden. Bitte Hardwarebeschleunigung im Browser aktivieren.');
    }
    this.gl = gl;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.0;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    setMaxAnisotropy(Math.min(8, gl.capabilities.getMaxAnisotropy()));
    container.appendChild(gl.domElement);
    gl.domElement.id = 'game-canvas';
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 9000);
    this.scene = new THREE.Scene();
    this.applyQuality(quality);
    window.addEventListener('resize', this.onResize);
    this.resize();
  }

  applyQuality(q: Quality): void {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.gl.setPixelRatio(q === 'high' ? Math.min(dpr, 2) : q === 'medium' ? Math.min(dpr, 1.25) : Math.min(dpr, 0.85));
    this.gl.shadowMap.enabled = q !== 'low';
    if (q === 'high') {
      if (!this.composer) {
        this.composer = new EffectComposer(this.gl);
        this.renderPass = new RenderPass(this.scene, this.camera);
        this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.35, 0.5, 0.88);
        this.composer.addPass(this.renderPass);
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
      }
    } else if (this.composer) {
      this.composer.dispose();
      this.composer = null;
      this.renderPass = null;
      this.bloom = null;
    }
    this.resize();
  }

  setScene(scene: THREE.Scene): void {
    this.scene = scene;
    if (this.renderPass) this.renderPass.scene = scene;
  }

  setBloom(strength: number): void {
    if (this.bloom) this.bloom.strength = strength;
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.gl.setSize(w, h, false);
    this.gl.domElement.style.width = '100%';
    this.gl.domElement.style.height = '100%';
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    if (this.composer) this.composer.setSize(w, h);
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.gl.render(this.scene, this.camera);
  }

  info(): { calls: number; triangles: number } {
    return { calls: this.gl.info.render.calls, triangles: this.gl.info.render.triangles };
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.composer?.dispose();
    this.gl.dispose();
    this.gl.domElement.remove();
  }
}
