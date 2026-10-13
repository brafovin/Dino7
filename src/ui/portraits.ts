// Stilisierte Fahrerkarten (SVG) und Streckenumrisse – eigene Designs, keine Fotos/Logos.
import type { Driver, Team } from '../shared/teams';
import type { Track } from '../shared/track';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Helm im Profil mit Fahrerfarben, Startnummer und Initialen. */
export function driverPortraitSVG(driver: Driver, team: Team): string {
  const [c1, c2, c3] = driver.helmet;
  const id = `g${driver.id}`;
  const initials = driver.name
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 3);
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${team.livery.primary}"/><stop offset="1" stop-color="${team.livery.secondary}"/></linearGradient>
    <linearGradient id="${id}sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <clipPath id="${id}cl"><path d="M18 62 C16 34 34 18 56 18 C76 18 88 32 88 50 L88 66 C88 74 82 80 74 80 L30 80 C22 80 18 72 18 62 Z"/></clipPath>
  </defs>
  <rect width="100" height="100" fill="url(#${id}bg)"/>
  <text x="50" y="96" font-family="Arial Black, Arial" font-size="38" font-style="italic" font-weight="900" text-anchor="middle" fill="#000" fill-opacity="0.18">${driver.number}</text>
  <g clip-path="url(#${id}cl)">
    <rect x="10" y="10" width="90" height="80" fill="${c1}"/>
    <path d="M10 56 L100 44 L100 58 L10 70 Z" fill="${c2}"/>
    <path d="M10 70 L100 58 L100 62 L10 74 Z" fill="${c3}"/>
    <path d="M10 10 L46 10 L22 40 L10 44 Z" fill="${c2}" opacity="0.85"/>
  </g>
  <path d="M18 62 C16 34 34 18 56 18 C76 18 88 32 88 50 L88 66 C88 74 82 80 74 80 L30 80 C22 80 18 72 18 62 Z" fill="url(#${id}sh)" stroke="#000" stroke-opacity="0.45" stroke-width="1.5"/>
  <path d="M54 40 L88 38 L88 52 L52 54 C49 54 48 42 54 40 Z" fill="#0b0d12"/>
  <path d="M56 41 L87 39.5 L87 42 L56 43.5 Z" fill="#7fc4ff" opacity="0.55"/>
  <text x="34" y="68" font-family="Arial Black, Arial" font-size="13" font-style="italic" font-weight="900" text-anchor="middle" fill="${c3}" stroke="#000" stroke-opacity="0.35" stroke-width="0.6">${driver.number}</text>
  <text x="8" y="14" font-family="Arial, sans-serif" font-size="9" font-weight="800" fill="#fff" fill-opacity="0.9">${esc(initials)}</text>
</svg>`;
}

const outlineCache = new Map<string, string>();

/** Streckenumriss als SVG (Pfad aus den Mittellinien-Samples). */
export function trackOutlineSVG(track: Track, color = '#ffffff', width = 3, withStart = true): string {
  const key = `${track.def.id}${color}${width}${withStart}`;
  const hit = outlineCache.get(key);
  if (hit) return hit;
  const pad = 40;
  const w = track.maxX - track.minX + pad * 2;
  const hgt = track.maxZ - track.minZ + pad * 2;
  const step = Math.max(1, Math.floor(track.n / 400));
  let d = '';
  for (let i = 0; i <= track.n; i += step) {
    const k = i % track.n;
    const x = (track.px[k] - track.minX + pad).toFixed(0);
    const z = (track.pz[k] - track.minZ + pad).toFixed(0);
    d += `${i === 0 ? 'M' : 'L'}${x} ${z} `;
  }
  d += 'Z';
  const sw = Math.max(w, hgt) / 100 * width * 0.6;
  const sx = track.px[0] - track.minX + pad;
  const sz = track.pz[0] - track.minZ + pad;
  const start = withStart ? `<circle cx="${sx.toFixed(0)}" cy="${sz.toFixed(0)}" r="${(sw * 1.6).toFixed(0)}" fill="#e8002d" stroke="#fff" stroke-width="${(sw * 0.5).toFixed(0)}"/>` : '';
  const svg = `<svg viewBox="0 0 ${w.toFixed(0)} ${hgt.toFixed(0)}" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="#000" stroke-opacity="0.5" stroke-width="${(sw * 2.2).toFixed(0)}" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${color}" stroke-width="${sw.toFixed(0)}" stroke-linejoin="round"/>${start}</svg>`;
  outlineCache.set(key, svg);
  return svg;
}
