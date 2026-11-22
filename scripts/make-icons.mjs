// Renders the app icons (192/512) from the same artwork as the game.
import { chromium } from 'playwright';
import { PORTRAITS } from '../client/src/portraits.js';
const b = await chromium.launch();
for (const size of [192, 512]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0;width:${size}px;height:${size}px;background:radial-gradient(circle at 50% 30%,#4b2fd1,#0b0820 75%);display:grid;place-items:center">
    <div style="width:${size * 0.62}px;height:${size * 0.62}px">${PORTRAITS.nova.replace('<svg', `<svg width="${size * 0.62}" height="${size * 0.62}"`)}</div></body>`);
  await p.screenshot({ path: new URL(`../client/public/icon-${size}.png`, import.meta.url).pathname });
}
await b.close();
console.log('wrote icons');
