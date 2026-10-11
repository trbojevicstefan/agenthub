import { chromium } from 'playwright';
import fs from 'fs';
const [,, mode, a, b, o] = process.argv; const out = mode === 'times' ? b : (o || 'frames');
const FPS = 30;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:8765/index.html?render=1');
await page.waitForFunction(() => window.READY || window.ERR, null, { timeout: 120000 });
const err = await page.evaluate(() => window.ERR); if (err) { console.log(err); process.exit(1); }
const times = mode === 'times' ? a.split(',').map(Number) : Array.from({ length: +b - +a }, (_, i) => (+a + i) / FPS);
const t0 = Date.now();
for (const [i, t] of times.entries()) {
  await page.evaluate(t => window.renderAt(t), t);
  const name = mode === 'times' ? `t${String(t).replace('.', '_')}.jpg` : `f${String(+a + i).padStart(5, '0')}.jpg`;
  await page.screenshot({ path: `${out}/${name}`, type: 'jpeg', quality: 93 });
  if (i % 100 === 0) console.log(mode, a, i, ((Date.now() - t0) / (i + 1)).toFixed(0) + 'ms/frame');
}
await browser.close();
