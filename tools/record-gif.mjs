// Graba la demo en frames PNG usando un reloj virtual (Playwright clock),
// de modo que la animación sale fluida aunque el navegador renderice lento.
//
// Uso (desde la raíz del repo):
//   npm i --no-save playwright gifsicle
//   npx playwright install chromium
//   node tools/record-gif.mjs
//   # → genera frames/ ; ver README para convertir a GIF/MP4 con ffmpeg + gifsicle
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'index.html')).href + '?name=HALCYON';
const W = 1600, H = 900, FPS = 12, STEP = 1000 / FPS;
const out = path.join(root, 'frames');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', e => console.error('page error:', e.message));
await page.clock.install();                 // tiempo virtual: rAF, performance.now, Date
await page.goto(url);
await page.addStyleTag({ content: '#fx{display:none}' }); // sin scanlines: GIF mucho más ligero
await page.waitForTimeout(3000);            // espera a que cargue Three.js desde el CDN

let n = 0;
const shot = () => page.screenshot({ path: path.join(out, `f${String(n++).padStart(4, '0')}.png`) });
const rec = async sec => { for (let i = 0; i < sec * FPS; i++) { await page.clock.runFor(STEP); await shot(); } };
const ff = async sec => { for (let i = 0; i < sec * 20; i++) await page.clock.runFor(50); };

await ff(16);                                            // arranque + despegue (sin grabar)
await rec(3.5);                                          // PATROL
await page.mouse.click(1000, 620); await rec(4);         // clic en el suelo → ORBIT
await page.keyboard.press('3'); await rec(4);            // FORMATION
await page.keyboard.press('Enter');                      // terminal integrada
for (const ch of 'mode scan') { await page.keyboard.type(ch); await rec(0.1); }
await page.keyboard.press('Enter'); await page.keyboard.press('Escape'); await rec(4.5); // SCAN
await page.keyboard.press('c'); await rec(3.5);          // cámara de persecución

console.log(`${n} frames → ${out}`);
await browser.close();
