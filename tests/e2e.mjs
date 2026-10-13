// End-to-End-Test im Browser: zwei getrennte Spiel-Clients (eigene Browser-Kontexte) bedienen die echte UI,
// erstellen/betreten eine Lobby, starten ein Online-Rennen und prüfen die Synchronisierung.
// Voraussetzung: laufender Dev-Server (npm run dev) oder gebauter Server (npm start) unter URL.
// Aufruf: node tests/e2e.mjs [URL]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
const URL = process.argv[2] ?? process.env.URL ?? 'http://localhost:5173/';
const OUT = 'tests/output';
mkdirSync(OUT, { recursive: true });
let fails = 0;
const check = (c, m) => {
  console.log(`  ${c ? '✓' : '✗'} ${m}`);
  if (!c) fails++;
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const mk = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL);
  await page.waitForTimeout(1500);
  await page.click('text=Verstanden').catch(() => undefined);
  await page.evaluate(() => {
    const app = window.__app;
    app.settings.update((s) => (s.graphics.quality = 'low'));
    app.applyQuality();
  });
  return { name, page, errors };
};

try {
  console.log('▶ Zwei Clients öffnen');
  const A = await mk('Anna');
  const B = await mk('Ben');
  for (const c of [A, B]) {
    await c.page.click('text=Online-Multiplayer');
    await c.page.waitForTimeout(400);
    await c.page.fill('input[type=text]', c.name);
  }
  console.log('▶ Lobby erstellen (A) und beitreten (B)');
  await A.page.click('button:has-text("Lobby erstellen")');
  await A.page.waitForSelector('text=Lobby-Code', { timeout: 10000 });
  await A.page.waitForTimeout(500);
  const code = (await A.page.locator('.panel .logo').first().textContent())?.trim();
  check(/^[A-Z0-9]{5}$/.test(code ?? ''), `Lobby-Code angezeigt: ${code}`);
  await B.page.fill('input.code-input', code);
  await B.page.click('button:has-text("Beitreten")');
  await B.page.waitForSelector('text=Lobby-Code', { timeout: 10000 });
  await A.page.waitForTimeout(1500);
  const countA = await A.page.locator('table.res tbody tr').count();
  const countB = await B.page.locator('table.res tbody tr').count();
  check(countA === 2 && countB === 2, `beide Clients zeigen 2 Spieler (${countA}/${countB})`);
  await B.page.click('button:has-text("Bereit")');
  await A.page.waitForTimeout(1200);
  check((await A.page.locator('text=BEREIT').count()) >= 1, 'Bereit-Status beim Host sichtbar');
  await A.page.screenshot({ path: `${OUT}/e2e-lobby-host.png` });
  console.log('▶ Rennen starten');
  await A.page.click('button:has-text("Rennen starten")');
  const racing = async (p) =>
    p.waitForFunction(() => window.__app?.session?.phase === 'racing', null, { timeout: 120000, polling: 500 }).then(
      () => true,
      () => false,
    );
  const [ra, rb] = await Promise.all([racing(A.page), racing(B.page)]);
  check(ra && rb, 'beide Clients im laufenden Rennen (gemeinsame Startampel)');
  console.log('▶ Fahren und Synchronisierung prüfen');
  await B.page.keyboard.down('KeyW');
  await A.page.keyboard.down('KeyW');
  await B.page.waitForTimeout(9000);
  const remoteSeen = await A.page.evaluate(() => {
    const s = window.__app.session;
    const other = s.cars.find((c) => !c.isPlayer);
    return { x: other.car.st.x, z: other.car.st.z, v: other.car.st.vx, name: other.playerName };
  });
  const own = await B.page.evaluate(() => {
    const s = window.__app.session;
    return { x: s.player.car.st.x, z: s.player.car.st.z, v: s.player.car.st.vx, ping: window.__app.net.ping };
  });
  const dist = Math.hypot(remoteSeen.x - own.x, remoteSeen.z - own.z);
  console.log(`    B lokal: (${own.x.toFixed(1)}, ${own.z.toFixed(1)}) ${(own.v * 3.6).toFixed(0)} km/h · bei A: (${remoteSeen.x.toFixed(1)}, ${remoteSeen.z.toFixed(1)}) · Abstand ${dist.toFixed(1)} m · Ping ${own.ping} ms`);
  check(own.v > 5, 'Client B fährt (Eingabe wirkt)');
  check(remoteSeen.name === 'Ben', 'A sieht Mitspieler „Ben“');
  // Toleranz: Interpolationsverzögerung + unterschiedliche Messzeitpunkte der beiden Seiten
  check(dist < Math.max(15, own.v * 0.8), 'Position von B ist bei A synchron (Interpolation)');
  const hudNet = await A.page.locator('.hud-net').textContent();
  check(/Online/.test(hudNet ?? ''), `Verbindungsstatus im HUD: ${hudNet?.trim()}`);
  await A.page.screenshot({ path: `${OUT}/e2e-race-A.png` });
  await B.page.screenshot({ path: `${OUT}/e2e-race-B.png` });
  await A.page.keyboard.up('KeyW');
  await B.page.keyboard.up('KeyW');
  console.log('▶ Rennen verlassen');
  await B.page.keyboard.press('Escape');
  await B.page.waitForTimeout(800);
  await B.page.click('button:has-text("Rennen verlassen")');
  await A.page.waitForTimeout(2500);
  const leftMsg = await A.page.evaluate(() => window.__app.session?.cars.find((c) => !c.isPlayer)?.dnf);
  check(leftMsg === true, 'A erkennt, dass B das Rennen verlassen hat');
  for (const c of [A, B]) check(c.errors.length === 0, `${c.name}: keine Laufzeitfehler (${c.errors.slice(0, 2).join(' | ')})`);
} catch (e) {
  console.error(e);
  fails++;
}
await browser.close();
console.log(fails ? `\n${fails} Prüfung(en) fehlgeschlagen` : '\nE2E bestanden');
process.exit(fails ? 1 : 0);
