// Entwicklungswerkzeug: Screenshot einer lokalen HTML-Datei oder URL.
// Aufruf: node tools/screenshot.mjs <datei|url> <ausgabe.png> [breite] [höhe]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
const [, , target, out, w = '1600', h = '1200'] = process.argv;
const url = /^https?:/.test(target) ? target : pathToFileURL(resolve(target)).href;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
await page.goto(url);
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('->', out);
