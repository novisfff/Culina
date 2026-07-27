import { defineConfig } from '@playwright/test';

const port = Number(process.env.CULINA_P0_PORT || 4174);
const baseURL = `http://127.0.0.1:${port}`;
const expectTimeout = Number(process.env.PLAYWRIGHT_EXPECT_TIMEOUT || 5_000);
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results';
const reportDir = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || 'playwright-report';
const retainFailureEvidence = process.env.PLAYWRIGHT_DISABLE_FAILURE_EVIDENCE !== '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  workers: process.env.CI ? 2 : 3,
  outputDir,
  reporter: [
    [process.env.CI ? 'line' : 'list'],
    ['html', { outputFolder: reportDir, open: 'never' }],
  ],
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}',
  expect: {
    timeout: expectTimeout,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    },
  },
  use: {
    baseURL,
    colorScheme: 'light',
    locale: 'zh-CN',
    reducedMotion: 'reduce',
    screenshot: retainFailureEvidence ? 'only-on-failure' : 'off',
    timezoneId: 'Asia/Shanghai',
    trace: retainFailureEvidence ? 'retain-on-failure' : 'off',
    video: retainFailureEvidence ? 'retain-on-failure' : 'off',
  },
  projects: [
    {
      name: 'phone-375x812',
      use: {
        viewport: { width: 375, height: 812 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'tablet-1180x820',
      use: {
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
      },
    },
    {
      name: 'desktop-1440x960',
      use: {
        viewport: { width: 1440, height: 960 },
      },
    },
  ],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
