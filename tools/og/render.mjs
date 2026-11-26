// Renders client/public/og.png from client/og.html (dev server must be running: npx vite client --port 5199)
// node tools/og/render.mjs [out.png] [seed]
import { chromium } from 'playwright';
const out = process.argv[2] || 'client/public/og.png', seed = process.argv[3] || '';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: 1200, height: 630 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto(`http://localhost:5199/og.html?lite=1${seed ? '&seed=' + seed : ''}`); // lite: no random yard trees in the way
await p.waitForSelector('body[data-done]', { timeout: 90000 });
await p.waitForTimeout(400);
await p.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
