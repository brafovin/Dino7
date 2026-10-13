// Mini-Streckenkarte (Canvas 2D).
import type { Track } from '../shared/track';

export interface MapDot {
  x: number;
  z: number;
  color: string;
  me: boolean;
  ghost?: boolean;
}

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement | null = null;
  private scale = 1;
  private ox = 0;
  private oz = 0;
  private readonly size: number;
  private readonly dpr: number;

  constructor(size = 170) {
    this.size = size;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas = document.createElement('canvas');
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.ctx = this.canvas.getContext('2d')!;
  }

  setTrack(track: Track): void {
    const S = this.size * this.dpr;
    const pad = 12 * this.dpr;
    const w = track.maxX - track.minX;
    const hgt = track.maxZ - track.minZ;
    this.scale = (S - pad * 2) / Math.max(w, hgt);
    this.ox = pad + ((S - pad * 2) - w * this.scale) / 2 - track.minX * this.scale;
    this.oz = pad + ((S - pad * 2) - hgt * this.scale) / 2 - track.minZ * this.scale;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(10,13,19,0.82)';
    g.beginPath();
    g.roundRect(0, 0, S, S, 10 * this.dpr);
    g.fill();
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= track.n; i += 2) {
        const k = i % track.n;
        const x = track.px[k] * this.scale + this.ox;
        const z = track.pz[k] * this.scale + this.oz;
        if (i === 0) g.moveTo(x, z);
        else g.lineTo(x, z);
      }
      g.closePath();
    };
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 7 * this.dpr;
    path();
    g.stroke();
    g.strokeStyle = '#d9dee6';
    g.lineWidth = 3.2 * this.dpr;
    path();
    g.stroke();
    // Start/Ziel
    const sx = track.px[0] * this.scale + this.ox;
    const sz = track.pz[0] * this.scale + this.oz;
    g.fillStyle = '#e8002d';
    g.fillRect(sx - 3 * this.dpr, sz - 3 * this.dpr, 6 * this.dpr, 6 * this.dpr);
    this.bg = c;
  }

  draw(dots: MapDot[]): void {
    const ctx = this.ctx;
    const S = this.size * this.dpr;
    ctx.clearRect(0, 0, S, S);
    if (this.bg) ctx.drawImage(this.bg, 0, 0);
    const r = 3.6 * this.dpr;
    // eigener Punkt zuletzt
    const sorted = dots.slice().sort((a, b) => Number(a.me) - Number(b.me));
    for (const d of sorted) {
      const x = d.x * this.scale + this.ox;
      const z = d.z * this.scale + this.oz;
      ctx.globalAlpha = d.ghost ? 0.5 : 1;
      ctx.beginPath();
      ctx.arc(x, z, d.me ? r * 1.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
      ctx.lineWidth = (d.me ? 2.2 : 1) * this.dpr;
      ctx.strokeStyle = d.me ? '#ffffff' : 'rgba(0,0,0,0.8)';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}
