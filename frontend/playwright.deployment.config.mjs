import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'realtime-websocket-deployment.spec.mjs',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 15_000,
  outputDir: 'test-results/websocket',
  reporter: [['list'], ['junit', { outputFile: 'test-results/websocket/results.xml' }]],
  use: {
    baseURL: process.env.CULINA_DEPLOYMENT_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
