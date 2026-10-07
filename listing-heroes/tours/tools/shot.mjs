// Screenshot a tour page at desktop and phone sizes, optionally at several scroll positions.
//   node tools/shot.mjs <url> <outPrefix> [scrollFractions=0] [waitMs=3500] [js-to-run-before-shot]
// Example: node tools/shot.mjs http://localhost:8765/dist/mission-house/preview.html /tmp/m "0,0.3,0.6" 4000
// Uses software WebGL (SwiftShader), so it is slow; give it time. Prints console errors.
import { chromium } from 'playwright';
const [, , url, out, fr = '0', wait = '3500', js = ''] = process.argv;
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [name, vp] of [['desk', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const pg = await b.newPage({ viewport: vp, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  pg.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name}] ${m.type()}:`, m.text()); });
  pg.on('pageerror', e => console.log(`[${name}] pageerror:`, e.message));
  await pg.goto(url, { waitUntil: 'load' });
  await pg.waitForTimeout(+wait);
  for (const f of fr.split(',').map(Number)) {
    await pg.evaluate(f => { const h = document.documentElement.scrollHeight - innerHeight; scrollTo(0, h * f); }, f);
    await pg.waitForTimeout(1500);
    if (js) await pg.evaluate(js);
    await pg.screenshot({ path: `${out}-${name}-${String(f).replace('.', '_')}.png` });
  }
  const ow = await pg.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (ow > 0) console.log(`[${name}] horizontal overflow ${ow}px`);
  await pg.close();
}
await b.close();
