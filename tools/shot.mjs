// Entwicklungswerkzeug: Spiel im Headless-Browser öffnen, Aktionen ausführen, Screenshots speichern.
// Aufruf: node tools/shot.mjs <szenario> [ausgabeordner]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
const scenario = process.argv[2] ?? 'menu';
const outDir = process.argv[3] ?? 'tests/output';
const url = process.env.URL ?? 'http://localhost:5173/';
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 720);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url);
await page.waitForTimeout(2500);
const shot = async (name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('->', `${outDir}/${name}.png`);
};

if (scenario === 'menu') {
  await shot('menu-first-run');
  await page.click('text=Verstanden').catch(() => undefined);
  await page.waitForTimeout(800);
  await shot('menu-main');
} else if (scenario.startsWith('race')) {
  const [, track = 'silverstone', kind = 'race', weather = 'dry', quality = 'medium', cam = 'tv'] = scenario.split(':');
  await page.click('text=Verstanden').catch(() => undefined);
  await page.evaluate(
    ({ track, kind, weather, quality, cam }) => {
      const app = window.__app;
      app.settings.update((s) => {
        s.graphics.quality = quality;
        s.camera.mode = cam;
      });
      app.applyQuality();
      app.startSession(
        {
          mode: kind === 'race' ? 'grandprix' : kind,
          trackId: track,
          laps: 3,
          weather,
          difficulty: 'normal',
          playerDriverId: 'leclerc',
          aiCount: 19,
          startMode: 'pole',
          wearScale: 1,
          startCompound: 'medium',
          transmission: 'auto',
          assists: { tc: 'high', abs: true, line: 'full', steering: true, brake: false, autoReset: true },
          seed: 42,
        },
        kind,
      );
    },
    { track, kind, weather, quality, cam },
  );
  await page.waitForTimeout(Number(process.env.WAIT ?? 9000));
  await shot(`${track}-${kind}-grid`);
  if (process.env.DRIVE) {
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(Number(process.env.DRIVE));
    await shot(`${track}-${kind}-driving`);
    await page.keyboard.up('KeyW');
  }
  const info = await page.evaluate(() => {
    const app = window.__app;
    const r = app.renderer.info();
    return { ...r, fps: app.fpsText };
  });
  console.log('renderinfo', JSON.stringify(info));
}
if (scenario.startsWith('tour')) {
  const [, track = 'monaco', quality = 'medium', weather = 'dry', fracs = '0.02,0.25,0.5,0.75', cam = 'tv'] = scenario.split(':');
  await page.click('text=Verstanden').catch(() => undefined);
  await page.evaluate(
    ({ track, quality, weather, cam }) => {
      const app = window.__app;
      app.settings.update((s) => {
        s.graphics.quality = quality;
        s.camera.mode = cam;
      });
      app.applyQuality();
      app.startSession(
        { mode: 'practice', trackId: track, laps: 3, weather, difficulty: 'normal', playerDriverId: 'verstappen', aiCount: 0, startMode: 'pole', wearScale: 1, startCompound: 'soft', transmission: 'auto', assists: { tc: 'high', abs: true, line: 'off', steering: true, brake: false, autoReset: true }, seed: 1 },
        'practice',
      );
    },
    { track, quality, weather, cam },
  );
  await page.waitForTimeout(Number(process.env.WAIT ?? 15000));
  for (const f of fracs.split(',').map(Number)) {
    await page.evaluate((f) => {
      const app = window.__app;
      const sess = app.session;
      const tr = sess.track;
      const s = f * tr.length;
      sess.player.car.placeAt(tr, s, tr.raceLine[tr.indexAt(s)], 30);
      sess.player.prevS = sess.player.car.st.s;
      Object.assign(sess.player.prev, { x: sess.player.car.st.x, y: sess.player.car.st.y, z: sess.player.car.st.z, heading: sess.player.car.st.heading });
    }, f);
    await page.waitForTimeout(Number(process.env.STEP ?? 2500));
    await shot(`tour-${track}-${quality}-${weather}-${cam}-${Math.round(f * 100)}`);
  }
  const info = await page.evaluate(() => ({ ...window.__app.renderer.info(), fps: window.__app.fpsText }));
  console.log('renderinfo', JSON.stringify(info));
}
console.log(logs.slice(0, 40).join('\n'));
await browser.close();
