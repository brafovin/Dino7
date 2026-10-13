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
if (scenario === 'menus') {
  await page.click('text=Verstanden').catch(() => undefined);
  await page.waitForTimeout(1500);
  await shot('m01-main');
  await page.click('text=Spielmodus wählen');
  await page.waitForTimeout(600);
  await shot('m02-mode');
  await page.click('.mode-card:has-text("Grand Prix")');
  await page.waitForTimeout(800);
  await shot('m03-driver');
  await page.click('.driver-card:has-text("Oscar Piastri")');
  await page.waitForTimeout(600);
  await page.click('text=Weiter →');
  await page.waitForTimeout(4000);
  await shot('m04-track');
  await page.click('.track-card:has-text("Suzuka")');
  await page.click('text=Weiter →');
  await page.waitForTimeout(3000);
  await shot('m05-config');
  await page.click('text=Alle Einstellungen');
  await page.waitForTimeout(600);
  await shot('m06-settings-gameplay');
  await page.click('.tabs button:has-text("Steuerung")');
  await page.waitForTimeout(400);
  await shot('m07-settings-controls');
  await page.click('.tabs button:has-text("Grafik")');
  await page.waitForTimeout(300);
  await shot('m08-settings-graphics');
  await page.click('text=Fertig');
  await page.waitForTimeout(400);
  await page.click('text=← Zurück');
  await page.waitForTimeout(400);
  await page.click('text=← Zurück');
  await page.waitForTimeout(400);
  await page.click('text=← Zurück');
  await page.waitForTimeout(400);
  await page.click('text=← Zurück');
  await page.waitForTimeout(600);
  await page.click('text=Online-Multiplayer');
  await page.waitForTimeout(600);
  await shot('m09-mp-connect');
}
if (scenario.startsWith('views')) {
  const [, track = 'silverstone'] = scenario.split(':');
  await page.click('text=Verstanden').catch(() => undefined);
  await page.evaluate((track) => {
    const app = window.__app;
    app.settings.update((s) => (s.graphics.quality = 'medium'));
    app.applyQuality();
    app.startSession({ mode: 'grandprix', trackId: track, laps: 1, weather: 'dry', difficulty: 'normal', playerDriverId: 'piastri', aiCount: 5, startMode: 'pole', wearScale: 1, startCompound: 'soft', transmission: 'manual', assists: { tc: 'low', abs: true, line: 'full', steering: false, brake: false, autoReset: true }, seed: 3 }, 'race');
  }, track);
  await page.waitForTimeout(Number(process.env.WAIT ?? 15000));
  for (const cam of ['cockpit', 'front', 'far', 'trackside']) {
    await page.evaluate((cam) => {
      const app = window.__app;
      app.settings.update((s) => (s.camera.mode = cam));
      app.applyRuntimeSettings();
    }, cam);
    await page.waitForTimeout(3500);
    await shot(`v-${track}-${cam}`);
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await shot(`v-${track}-pause`);
  await page.click('text=Fortsetzen');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const app = window.__app;
    app.session.forceFinish();
    app.showResults();
  });
  await page.waitForTimeout(2500);
  await shot(`v-${track}-results`);
}
if (scenario === 'functional') {
  let fails = 0;
  const check = (c, m) => {
    console.log(`  ${c ? '✓' : '✗'} ${m}`);
    if (!c) fails++;
  };
  await page.click('text=Verstanden').catch(() => undefined);
  // Einstellungen + Persistenz
  await page.evaluate(() => {
    const app = window.__app;
    app.setDifficultyForTest = true;
    app.settings.setDifficulty('hard');
    app.settings.update((s) => {
      s.controls.bindings.camera = ['KeyV'];
      s.audio.engine = 0.55;
      s.graphics.quality = 'low';
      s.transmission = 'manual';
    });
  });
  await page.reload();
  await page.waitForTimeout(2500);
  const persisted = await page.evaluate(() => {
    const s = window.__app.settings.data;
    return { d: s.difficulty, cam: s.controls.bindings.camera.join(), eng: s.audio.engine, q: s.graphics.quality, tr: s.transmission, steer: s.assists.steering, first: s.firstRunDone };
  });
  check(persisted.d === 'hard' && persisted.cam === 'KeyV' && persisted.eng === 0.55 && persisted.q === 'low' && persisted.tr === 'manual', `Einstellungen nach Neuladen erhalten (${JSON.stringify(persisted)})`);
  check(persisted.steer === false, 'Schwierigkeit „Schwer“ sperrt die Lenkhilfe');
  check(persisted.first === true, 'Steuerungshinweis nur beim ersten Start');
  // Training starten (manuelles Getriebe)
  await page.mouse.click(10, 10);
  await page.evaluate(() => {
    const app = window.__app;
    app.startSession({ mode: 'practice', trackId: 'monza', laps: 1, weather: 'dry', difficulty: 'hard', playerDriverId: 'albon', aiCount: 0, startMode: 'pole', wearScale: 1, startCompound: 'soft', transmission: 'manual', assists: { tc: 'low', abs: true, line: 'off', steering: false, brake: false, autoReset: false }, seed: 1 }, 'practice');
  });
  await page.waitForFunction(() => window.__app?.session?.phase === 'racing' && window.__app.race, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const read = () => page.evaluate(() => {
    const a = window.__app;
    const st = a.session.player.car.st;
    const o = a.audio.player?.oscs?.[0]?.frequency?.value ?? null;
    return { gear: st.gear, rpm: st.rpm, v: st.vx, s: st.s, cam: a.settings.data.camera.mode, paused: a.race?.paused, osc: o, ctx: a.audio.ctx?.state ?? 'none', smoke: a.race?.smoke?.parts?.length ?? -1 };
  });
  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => window.__app.session.player.car.st.rpm > 11500, null, { timeout: 60000 }).catch(() => undefined);
  let r1 = await read();
  check(r1.gear === 1 && r1.rpm > 11000, `Manuell: bleibt im 1. Gang bis zum Begrenzer (${r1.rpm.toFixed(0)} U/min)`);
  check(r1.ctx === 'running' && r1.osc !== null && Math.abs(r1.osc - (r1.rpm / 60) * 3) < 80, `Motorsound folgt der Drehzahl (Oszillator ${r1.osc?.toFixed(0)} Hz, Soll ${((r1.rpm / 60) * 3).toFixed(0)} Hz, Audio ${r1.ctx})`);
  await page.keyboard.press('ShiftLeft');
  await page.waitForTimeout(1500);
  let r2 = await read();
  check(r2.gear === 2, `Shift links schaltet hoch (Gang ${r2.gear})`);
  await page.keyboard.press('ControlLeft');
  await page.waitForTimeout(1200);
  const r3 = await read();
  check(r3.gear === 1 || r3.gear === 2, `Strg links schaltet herunter bzw. Überdrehschutz greift (Gang ${r3.gear})`);
  await page.keyboard.up('KeyW');
  // Kamera mit neu belegter Taste V
  const camBefore = (await read()).cam;
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(1200);
  const camAfter = (await read()).cam;
  check(camBefore !== camAfter, `neu belegte Kamerataste V wechselt die Kamera (${camBefore} → ${camAfter})`);
  // Reset
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(1200);
  const r4 = await read();
  check(Math.abs(r4.v) < 3, 'R setzt das Fahrzeug zurück (Stillstand auf der Ideallinie)');
  // Bremsen ohne ABS -> Rauch/Bremsspuren
  await page.evaluate(() => {
    const s = window.__app.session;
    s.player.car.assists.abs = false;
    s.player.car.placeAt(s.track, 200, 0, 70);
  });
  await page.keyboard.down('KeyS');
  await page.waitForTimeout(2500);
  const r5 = await read();
  await page.keyboard.up('KeyS');
  check(r5.smoke > 0, `Blockierende Räder erzeugen Reifenrauch (${r5.smoke} Partikel)`);
  // Pause
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);
  const p1 = await read();
  check(p1.paused === true && (await page.locator('text=Fortsetzen').count()) > 0, 'Esc öffnet das Pausemenü und hält die Simulation an');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  const p2 = await read();
  check(p2.paused === false, 'Esc im Pausemenü setzt fort');
  // Tab-Wechsel: Einzelspieler pausiert automatisch, Zeit springt nicht
  const tBefore = await page.evaluate(() => window.__app.session.time);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(3000);
  const hiddenState = await page.evaluate(() => ({ paused: window.__app.race.paused, t: window.__app.session.time }));
  check(hiddenState.paused === true, 'Tab-Wechsel pausiert das Einzelspieler-Rennen automatisch');
  check(hiddenState.t - tBefore < 0.5, `Simulationszeit läuft im Hintergrund nicht weiter (+${(hiddenState.t - tBefore).toFixed(2)} s)`);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.click('text=Fortsetzen');
  await page.waitForTimeout(800);
  await shot('functional-end');
  check(!logs.some((l) => l.startsWith('[pageerror]')), 'keine Laufzeitfehler');
  console.log(fails ? `${fails} fehlgeschlagen` : 'FUNKTIONSTEST BESTANDEN');
}
if (scenario === 'sizes') {
  await page.click('text=Verstanden').catch(() => undefined);
  for (const [w, h] of [[1920, 1080], [1024, 768], [800, 600], [430, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1500);
    await shot(`size-menu-${w}x${h}`);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    const app = window.__app;
    app.settings.update((s) => (s.graphics.quality = 'low'));
    app.applyQuality();
    app.startSession({ mode: 'grandprix', trackId: 'zandvoort', laps: 2, weather: 'dry', difficulty: 'normal', playerDriverId: 'gasly', aiCount: 19, startMode: 'random', wearScale: 1, startCompound: 'medium', transmission: 'auto', assists: { tc: 'high', abs: true, line: 'full', steering: true, brake: false, autoReset: true }, seed: 5 }, 'race');
  });
  await page.waitForTimeout(15000);
  for (const [w, h] of [[1920, 1080], [1024, 768], [800, 600]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(2500);
    await shot(`size-race-${w}x${h}`);
  }
}
console.log(logs.filter((l) => !l.includes('[vite]')).slice(0, 40).join('\n'));
await browser.close();
