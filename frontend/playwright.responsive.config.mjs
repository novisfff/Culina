import { defineConfig } from '@playwright/test';
import p0 from './playwright.config.mjs';

// Optional layout sweep; each viewport gets a fresh context and independent result.
export default defineConfig({
  ...p0,
  testMatch: 'model-settings-responsive.spec.mjs',
  projects: [
    [375, 812], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900],
  ].map(([width, height]) => ({
    name: `layout-${width}x${height}`,
    use: { viewport: { width, height }, hasTouch: width <= 1024, isMobile: width < 768 },
  })),
});
