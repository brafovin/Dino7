// Prozedurale Canvas-Texturen – keine externen Assets nötig.
import * as THREE from 'three';
import { mulberry32 } from '../shared/math';

const cache = new Map<string, THREE.Texture>();
let maxAniso = 4;
export function setMaxAnisotropy(a: number): void {
  maxAniso = a;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D nicht verfügbar');
  return [c, ctx];
}

function toTex(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = maxAniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number, seed: number, speck = 0): void {
  const img = ctx.createImageData(w, h);
  const rnd = mulberry32(seed);
  for (let i = 0; i < w * h; i++) {
    let n = (rnd() - 0.5) * amp;
    if (speck && rnd() < speck) n += (rnd() - 0.3) * amp * 3;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function asphaltTexture(): THREE.Texture {
  return cached('asphalt', () => {
    const [c, ctx] = canvas(512, 512);
    noise(ctx, 512, 512, [78, 79, 82], 26, 11, 0.04);
    // leichte Fahrspuren / Gummiabrieb in Längsrichtung
    const rnd = mulberry32(5);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(30,30,32,${0.03 + rnd() * 0.05})`;
      const x = rnd() * 512;
      ctx.fillRect(x, 0, 6 + rnd() * 30, 512);
    }
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = `rgba(120,120,125,${0.03 + rnd() * 0.04})`;
      ctx.fillRect(rnd() * 512, rnd() * 512, 20 + rnd() * 80, 4 + rnd() * 10);
    }
    return toTex(c);
  });
}

export function rubberTexture(): THREE.Texture {
  return cached('rubber', () => {
    const [c, ctx] = canvas(256, 256);
    ctx.clearRect(0, 0, 256, 256);
    const rnd = mulberry32(77);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(10,10,10,${0.05 + rnd() * 0.12})`;
      ctx.fillRect(100 + (rnd() - 0.5) * 70, 0, 2 + rnd() * 6, 256);
    }
    return toTex(c);
  });
}

export function grassTexture(): THREE.Texture {
  return cached('grass', () => {
    const [c, ctx] = canvas(512, 512);
    noise(ctx, 512, 512, [200, 200, 200], 40, 21, 0.02);
    // Mähstreifen
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
      ctx.fillRect(0, i * 64, 512, 64);
    }
    return toTex(c);
  });
}

export function detailTexture(): THREE.Texture {
  return cached('detail', () => {
    const [c, ctx] = canvas(256, 256);
    noise(ctx, 256, 256, [215, 215, 215], 50, 33, 0.05);
    return toTex(c);
  });
}

export function gravelTexture(): THREE.Texture {
  return cached('gravel', () => {
    const [c, ctx] = canvas(256, 256);
    noise(ctx, 256, 256, [186, 168, 136], 50, 41, 0.15);
    return toTex(c);
  });
}

export function runoffTexture(): THREE.Texture {
  return cached('runoff', () => {
    const [c, ctx] = canvas(256, 256);
    noise(ctx, 256, 256, [92, 96, 102], 22, 51, 0.03);
    return toTex(c);
  });
}

export function curbTexture(colorA = '#d81e1e', colorB = '#f4f4f4'): THREE.Texture {
  return cached(`curb${colorA}${colorB}`, () => {
    const [c, ctx] = canvas(64, 256);
    ctx.fillStyle = colorA;
    ctx.fillRect(0, 0, 64, 128);
    ctx.fillStyle = colorB;
    ctx.fillRect(0, 128, 64, 128);
    // Rillen
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = 0; y < 256; y += 16) ctx.fillRect(0, y, 64, 3);
    return toTex(c);
  });
}

export function checkerTexture(): THREE.Texture {
  return cached('checker', () => {
    const [c, ctx] = canvas(128, 32);
    for (let x = 0; x < 16; x++)
      for (let y = 0; y < 4; y++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f2f2f2';
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    const t = toTex(c);
    t.magFilter = THREE.NearestFilter;
    return t;
  });
}

const BRANDS = [
  ['VELOX', '#0b2a6e', '#ffffff'],
  ['APEX OIL', '#111111', '#ffcc00'],
  ['NORDLICHT', '#073b4c', '#64d2ff'],
  ['TURBOMAX', '#c1121f', '#ffffff'],
  ['GRID ONE', '#ffffff', '#111111'],
  ['KAPPA TYRES', '#ffd400', '#111111'],
  ['ORBITAL', '#2b2d42', '#ef233c'],
  ['MERIDIAN', '#006d77', '#ffffff'],
  ['VOLTA ENERGY', '#14213d', '#fca311'],
  ['SPEEDLINE', '#e9ecef', '#d00000'],
  ['AURUM WATCHES', '#1b1b1b', '#d4af37'],
  ['FLUX TELECOM', '#5a189a', '#ffffff'],
];

export function bannerTexture(): THREE.Texture {
  return cached('banner', () => {
    const [c, ctx] = canvas(2048, 128);
    const w = 2048 / 8;
    for (let i = 0; i < 8; i++) {
      const [name, bg, fg] = BRANDS[i % BRANDS.length];
      ctx.fillStyle = bg;
      ctx.fillRect(i * w, 0, w, 128);
      ctx.fillStyle = fg;
      ctx.font = 'bold 54px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, i * w + w / 2, 66, w - 20);
    }
    return toTex(c);
  });
}

export function banner2Texture(): THREE.Texture {
  return cached('banner2', () => {
    const [c, ctx] = canvas(2048, 128);
    const w = 2048 / 8;
    for (let i = 0; i < 8; i++) {
      const [name, bg, fg] = BRANDS[(i + 5) % BRANDS.length];
      ctx.fillStyle = bg;
      ctx.fillRect(i * w, 0, w, 128);
      ctx.fillStyle = fg;
      ctx.font = 'bold 54px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, i * w + w / 2, 66, w - 20);
    }
    return toTex(c);
  });
}

export function armcoTexture(): THREE.Texture {
  return cached('armco', () => {
    const [c, ctx] = canvas(256, 128);
    ctx.fillStyle = '#4a4f55';
    ctx.fillRect(0, 0, 256, 128);
    const g = ctx.createLinearGradient(0, 0, 0, 40);
    g.addColorStop(0, '#d9dde2');
    g.addColorStop(0.5, '#9aa2ab');
    g.addColorStop(1, '#c7ccd2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 14, 256, 40);
    ctx.fillRect(0, 70, 256, 40);
    ctx.fillStyle = '#3a3f45';
    ctx.fillRect(0, 54, 256, 16);
    ctx.fillStyle = '#2b2f33';
    ctx.fillRect(120, 0, 16, 128);
    return toTex(c);
  });
}

export function tecproTexture(): THREE.Texture {
  return cached('tecpro', () => {
    const [c, ctx] = canvas(256, 128);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? '#d61f1f' : '#1f4fd6';
      ctx.fillRect(i * 64, 0, 64, 128);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(i * 64 + 4, 6, 56, 10);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(i * 64, 0, 3, 128);
    }
    return toTex(c);
  });
}

export function fenceTexture(): THREE.Texture {
  return cached('fence', () => {
    const [c, ctx] = canvas(128, 128);
    ctx.clearRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(200,205,210,0.85)';
    ctx.lineWidth = 2;
    for (let i = -128; i < 256; i += 16) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 128, 128);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(i + 128, 0);
      ctx.lineTo(i, 128);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(80,85,90,1)';
    ctx.fillRect(0, 0, 6, 128);
    ctx.fillRect(0, 0, 128, 4);
    return toTex(c);
  });
}

export function facadeTexture(seed: number, night = false): THREE.Texture {
  return cached(`facade${seed}${night}`, () => {
    const [c, ctx] = canvas(256, 512);
    const rnd = mulberry32(seed);
    ctx.fillStyle = night ? '#2a2a33' : '#e8e2d4';
    ctx.fillRect(0, 0, 256, 512);
    for (let y = 8; y < 512; y += 32) {
      for (let x = 8; x < 256; x += 32) {
        const lit = night ? rnd() < 0.55 : false;
        ctx.fillStyle = lit ? `rgba(255,${200 + rnd() * 50},${120 + rnd() * 80},1)` : night ? '#14151c' : `rgba(60,80,100,${0.6 + rnd() * 0.3})`;
        ctx.fillRect(x, y, 18, 20);
      }
    }
    return toTex(c);
  });
}

export function garageTexture(): THREE.Texture {
  return cached('garage', () => {
    const [c, ctx] = canvas(256, 128);
    ctx.fillStyle = '#20232a';
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#353a44';
    for (let y = 0; y < 128; y += 10) ctx.fillRect(0, y, 256, 2);
    return toTex(c);
  });
}

/** Startnummer-/Namensaufkleber (transparent). */
export function numberDecal(num: number, color: string, outline = '#000'): THREE.Texture {
  return cached(`num${num}${color}${outline}`, () => {
    const [c, ctx] = canvas(128, 128);
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = 'italic 900 88px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = outline;
    ctx.strokeText(String(num), 64, 68);
    ctx.fillStyle = color;
    ctx.fillText(String(num), 64, 68);
    return toTex(c, false);
  });
}

export function textDecal(text: string, color: string, bg: string | null = null, w = 512, h = 96): THREE.Texture {
  return cached(`txt${text}${color}${bg}${w}`, () => {
    const [c, ctx] = canvas(w, h);
    ctx.clearRect(0, 0, w, h);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.font = `italic 900 ${Math.floor(h * 0.62)}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, w / 2, h * 0.54, w - 16);
    return toTex(c, false);
  });
}

export function helmetTexture(c1: string, c2: string, c3: string, num: number): THREE.Texture {
  return cached(`helm${c1}${c2}${c3}${num}`, () => {
    const [c, ctx] = canvas(256, 128);
    ctx.fillStyle = c1;
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = c2;
    ctx.fillRect(0, 50, 256, 26);
    ctx.fillStyle = c3;
    ctx.fillRect(0, 76, 256, 8);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(80, 0);
    ctx.lineTo(30, 50);
    ctx.lineTo(0, 50);
    ctx.fill();
    // Visier
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(150, 34, 106, 22);
    ctx.fillStyle = 'rgba(120,180,255,0.35)';
    ctx.fillRect(150, 34, 106, 5);
    ctx.font = 'bold 26px Arial';
    ctx.fillStyle = c3;
    ctx.fillText(String(num), 40, 110);
    return toTex(c, true);
  });
}

export function tyreSidewallTexture(compoundColor: string): THREE.Texture {
  return cached(`tyre${compoundColor}`, () => {
    const [c, ctx] = canvas(256, 256);
    ctx.fillStyle = '#16171a';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = compoundColor;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(128, 128, 100, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#d9d9d9';
    ctx.font = 'bold 20px Arial';
    ctx.textAlign = 'center';
    for (let k = 0; k < 2; k++) {
      ctx.save();
      ctx.translate(128, 128);
      ctx.rotate(k * Math.PI);
      ctx.fillText('APEX', 0, -82);
      ctx.restore();
    }
    return toTex(c, false);
  });
}

export function rimTexture(accent: string): THREE.Texture {
  return cached(`rim${accent}`, () => {
    const [c, ctx] = canvas(128, 128);
    ctx.fillStyle = '#2c2f35';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#9097a1';
    for (let k = 0; k < 10; k++) {
      ctx.save();
      ctx.translate(64, 64);
      ctx.rotate((k / 10) * Math.PI * 2);
      ctx.fillRect(-4, 10, 8, 50);
      ctx.restore();
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#1a1c20';
    ctx.beginPath();
    ctx.arc(64, 64, 12, 0, Math.PI * 2);
    ctx.fill();
    return toTex(c, false);
  });
}

export function glowTexture(): THREE.Texture {
  return cached('glow', () => {
    const [c, ctx] = canvas(64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return toTex(c, false);
  });
}

export function smokeTexture(): THREE.Texture {
  return cached('smoke', () => {
    const [c, ctx] = canvas(64, 64);
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return toTex(c, false);
  });
}

export function disposeTextureCache(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
