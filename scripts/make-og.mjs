// Renders client/public/og.png (1200×630 link preview) from the real mover portraits.
import { chromium } from 'playwright';
import { PORTRAITS } from '../client/src/portraits.js';
const html = `<html><body style="margin:0;width:1200px;height:630px;overflow:hidden;font-family:system-ui,sans-serif;
background:radial-gradient(900px 500px at 75% 10%,#3a2a9b 0%,#0b0820 70%);color:#f4f1ff;position:relative">
<div style="position:absolute;inset:0;background-image:radial-gradient(#fff 1px,transparent 1.5px);background-size:46px 46px;opacity:.18"></div>
<div style="position:absolute;left:70px;top:70px;width:640px">
  <div style="font-size:26px;letter-spacing:6px;color:#55ffcc;font-weight:800">MOVING-DAY PARTY GAME</div>
  <div style="font-size:104px;font-weight:900;line-height:.95;margin-top:14px">LET’S<br><span style="color:#ff8a3d">MOVE IT</span></div><div style="font-size:24px;color:#cfc8f5;margin-top:10px">by Starside Movers</div>
  <div style="font-size:30px;color:#cfc8f5;margin-top:24px;line-height:1.3">Stack the truck. Don’t crush the fragile box.</div>
  <div style="display:inline-block;margin-top:22px;background:#6b4dff;padding:14px 26px;border-radius:18px;font-size:26px;font-weight:800">Play free in your browser ▶</div>
</div>
<div style="position:absolute;right:40px;bottom:90px;width:430px;height:300px">
  <div style="position:absolute;left:0;bottom:0;width:300px;height:170px;background:#f4f1ff;border-radius:16px 0 0 16px"></div>
  <div style="position:absolute;left:300px;bottom:0;width:130px;height:190px;background:#6b4dff;border-radius:0 30px 16px 0"></div>
  <div style="position:absolute;left:22px;bottom:64px;font-size:21px;font-weight:900;color:#6b4dff">★ STARSIDE MOVERS</div>
  <div style="position:absolute;left:40px;bottom:-26px;width:56px;height:56px;border-radius:50%;background:#1a1a24"></div>
  <div style="position:absolute;left:320px;bottom:-26px;width:56px;height:56px;border-radius:50%;background:#1a1a24"></div>
  <div style="position:absolute;left:30px;bottom:170px;display:flex;gap:4px">
    <div style="width:70px;height:70px;background:#c89b5f;border:3px solid #3a2a1a;border-radius:6px"></div>
    <div style="width:70px;height:70px;background:#7a5534;border:3px solid #3a2a1a;border-radius:6px"></div>
    <div style="width:70px;height:70px;background:#f2d16b;border:3px solid #3a2a1a;border-radius:6px"></div>
  </div>
</div>
<div style="position:absolute;left:66px;bottom:14px;display:flex;gap:8px">${Object.values(PORTRAITS).map(s => `<div style="width:84px;height:84px">${s.replace("<svg", "<svg width=\"84\" height=\"84\"")}</div>`).join('')}</div>
</body></html>`;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
await p.setContent(html);
await p.screenshot({ path: new URL('../client/public/og.png', import.meta.url).pathname });
await b.close();
console.log('wrote client/public/og.png');
