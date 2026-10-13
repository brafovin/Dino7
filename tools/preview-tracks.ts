// Entwicklungswerkzeug: baut alle Strecken, gibt Kennzahlen aus und erzeugt eine SVG-Übersicht.
// Aufruf: npx tsx tools/preview-tracks.ts [ausgabe.html]
import { writeFileSync } from 'node:fs';
import { Track, describeRaw } from '../src/shared/track';
import { TRACK_DEFS } from '../src/shared/trackDefs';

const out = process.argv[2] ?? 'tests/output/tracks.html';
const only = process.argv[3];
const cards: string[] = [];

for (const def of TRACK_DEFS) {
  if (only && def.id !== only) continue;
  const t0 = performance.now();
  const tr = new Track(def);
  const ms = performance.now() - t0;
  const raw = describeRaw(def);
  const autos = def.segs
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => (s.k === 'S' && s.o.auto) || (s.k === 'C' && s.o.autoAng))
    .map(({ s, i }) => (s.k === 'S' ? `S#${i}=${raw.segLen[i].toFixed(0)}m` : `C#${i}=${((raw.segLen[i] / s.r) * 180 / Math.PI).toFixed(0)}°`));
  let minR = Infinity;
  for (let i = 0; i < tr.n; i++) minR = Math.min(minR, 1 / Math.max(1e-6, Math.abs(tr.curv[i])));
  console.log(
    `${def.id.padEnd(12)} raw=${raw.rawLength.toFixed(0)}m scale=${tr.scale.toFixed(3)} n=${tr.n} corners=${tr.corners.length} ` +
      `minR=${minR.toFixed(1)} bbox=${(tr.maxX - tr.minX).toFixed(0)}x${(tr.maxZ - tr.minZ).toFixed(0)} y=[${tr.minY.toFixed(1)},${tr.maxY.toFixed(1)}] ` +
      `${autos.join(' ')} ${ms.toFixed(0)}ms ${tr.warnings.length ? 'WARN: ' + [...new Set(tr.warnings)].slice(0, 4).join('; ') : ''}`,
  );
  const pad = 60;
  const w = tr.maxX - tr.minX + pad * 2;
  const h = tr.maxZ - tr.minZ + pad * 2;
  const X = (x: number) => (x - tr.minX + pad).toFixed(1);
  const Z = (z: number) => (z - tr.minZ + pad).toFixed(1);
  const line = (fx: (i: number) => [number, number]) => {
    let d = '';
    for (let i = 0; i <= tr.n; i += 2) {
      const [x, z] = fx(i % tr.n);
      d += `${i === 0 ? 'M' : 'L'}${X(x)},${Z(z)}`;
    }
    return d + 'Z';
  };
  const center = line((i) => [tr.px[i], tr.pz[i]]);
  const bl = line((i) => [tr.px[i] + tr.nx[i] * tr.barL[i], tr.pz[i] + tr.nz[i] * tr.barL[i]]);
  const br = line((i) => [tr.px[i] - tr.nx[i] * tr.barR[i], tr.pz[i] - tr.nz[i] * tr.barR[i]]);
  // Höhe als Farbe
  let segs = '';
  for (let i = 0; i < tr.n; i += 3) {
    const j = (i + 3) % tr.n;
    const f = (tr.py[i] - tr.minY) / Math.max(1, tr.maxY - tr.minY);
    const col = `hsl(${(1 - f) * 220},80%,45%)`;
    segs += `<line x1="${X(tr.px[i])}" y1="${Z(tr.pz[i])}" x2="${X(tr.px[j])}" y2="${Z(tr.pz[j])}" stroke="${col}" stroke-width="${tr.halfW[i] * 2}" stroke-linecap="round"/>`;
  }
  let labels = '';
  for (const c of tr.corners) {
    if (!c.name) continue;
    labels += `<text x="${X(tr.px[c.apex])}" y="${Z(tr.pz[c.apex])}" font-size="${Math.max(16, w / 70)}" fill="#000">${c.name}</text>`;
  }
  const sf = `<circle cx="${X(tr.px[0])}" cy="${Z(tr.pz[0])}" r="${Math.max(10, w / 120)}" fill="red"/>`;
  const p1 = Math.floor(tr.n * 0.01);
  const arrow = `<line x1="${X(tr.px[0])}" y1="${Z(tr.pz[0])}" x2="${X(tr.px[p1 * 6])}" y2="${Z(tr.pz[p1 * 6])}" stroke="red" stroke-width="${w / 200}"/>`;
  const pitPts: string[] = [];
  for (let k = -400; k <= 400; k += 4) {
    const s = tr.wrapS(k);
    if (!tr.inRange(s, tr.pit.sEntry, tr.pit.sExit)) continue;
    const p = { x: 0, y: 0, z: 0, tx: 0, tz: 0 };
    tr.pointAt(s, tr.pitPathD(s, null), p);
    pitPts.push(`${X(p.x)},${Z(p.z)}`);
  }
  const pit = `<polyline points="${pitPts.join(' ')}" fill="none" stroke="#c0f" stroke-width="3"/>`;
  cards.push(`<div class="c"><h3>${def.name} – ${(tr.length / 1000).toFixed(3)} km, scale ${tr.scale.toFixed(2)}</h3>
  <svg viewBox="0 0 ${w.toFixed(0)} ${h.toFixed(0)}" width="760" height="${(760 * h / w).toFixed(0)}">
  <path d="${bl}" fill="none" stroke="#888" stroke-width="2"/><path d="${br}" fill="none" stroke="#888" stroke-width="2"/>
  ${segs}<path d="${center}" fill="none" stroke="#fff" stroke-width="1"/>${pit}${sf}${arrow}${labels}</svg></div>`);
}

writeFileSync(
  out,
  `<!doctype html><html><head><style>body{font-family:sans-serif;background:#eee;margin:0;display:flex;flex-wrap:wrap}.c{background:#fff;margin:6px;padding:6px}h3{margin:2px}</style></head><body>${cards.join('')}</body></html>`,
);
console.log('->', out);
