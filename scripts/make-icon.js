// Renders the app icon (build/icon.png, 512x512) with Electron.
// Usage: npx electron scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const SIZE = 512;
const html = `<!doctype html><html style="margin:0;overflow:hidden;background:transparent"><body style="margin:0;overflow:hidden;background:transparent">
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a3550"/>
      <stop offset="1" stop-color="#151a26"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="111.5" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="3"/>
  <!-- three dashboard bars -->
  <rect x="112" y="150" width="210" height="44" rx="22" fill="#7aa7ff"/>
  <rect x="112" y="234" width="288" height="44" rx="22" fill="#52d6a4"/>
  <rect x="112" y="318" width="150" height="44" rx="22" fill="#8b93a7"/>
  <!-- notification dot -->
  <circle cx="384" cy="172" r="40" fill="#ffbd59" stroke="#151a26" stroke-width="14"/>
</svg></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, transparent: true, frame: false, useContentSize: true });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log(`Wrote ${out}`);
  app.quit();
});
