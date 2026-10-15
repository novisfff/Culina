// Regenerate only the README banner; user-supplied page screenshots stay untouched.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../frontend/node_modules/playwright/index.mjs';

const root = new URL('../../', import.meta.url);
const dataURL = async (path, type) => `data:${type};base64,${(await readFile(new URL(path, root))).toString('base64')}`;
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 440 }, deviceScaleFactor: 1 });
  const template = await readFile(new URL('./banner.html', import.meta.url), 'utf8');
  await page.setContent(template
    .replace('{{LOGO}}', await dataURL('frontend/public/icon-192.png', 'image/png'))
    .replace('{{KITCHEN}}', await dataURL('frontend/public/images/family-kitchen-cover.jpg', 'image/jpeg')));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (image) => image.decode()));
  });
  await page.screenshot({ path: fileURLToPath(new URL('./banner.png', import.meta.url)), animations: 'disabled' });
  console.log('banner.png · 1280 × 440');
} finally {
  await browser.close();
}
