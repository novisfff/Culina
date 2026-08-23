import { defineConfig } from '@playwright/test';

const baseURL = process.env.CULINA_DEPLOYMENT_BASE_URL || 'http://127.0.0.1:18080';

export default defineConfig({
  testDir: './e2e',
  testMatch: /realtime-websocket-deployment\.spec\.mjs/,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  workers: 1,
  reporter: [['line']],
  use: {
    baseURL,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'deployment-chromium', use: { browserName: 'chromium' } }],
});
