// Renders the app icons from client/icon.html (dev server running: npx vite client --port 5199): node tools/og/icons.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
p.on('pageerror', e => console.log('ERR', e.message));
const shot = async (q) => { await p.goto('http://localhost:5199/icon.html' + q); await p.waitForSelector('body[data-done]', { timeout: 60000 }); await p.waitForTimeout(300); return p.screenshot({ type: 'png' }); };
const plain = await shot(''), masked = await shot('?mask=1');
// each size: draw the 1024 render down in the page (smooth resampling) and save
for (const [name, size, big] of [['icon-512.png', 512, plain], ['icon-192.png', 192, plain], ['apple-touch-icon.png', 180, plain], ['favicon-32.png', 32, plain], ['icon-maskable-512.png', 512, masked], ['icon-maskable-192.png', 192, masked]]) {
  const data = await p.evaluate(async ([b64, size]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, size, size);
    return c.toDataURL('image/png').split(',')[1];
  }, [big.toString('base64'), size]);
  (await import('fs')).writeFileSync(`client/public/${name}`, Buffer.from(data, 'base64'));
  console.log('wrote', name);
}
await browser.close();
