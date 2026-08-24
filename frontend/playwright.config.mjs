import { defineConfig } from '@playwright/test';

const port = Number(process.env.CULINA_P0_PORT || 4174);
const baseURL = `http://127.0.0.1:${port}`;
const expectTimeout = Number(process.env.PLAYWRIGHT_EXPECT_TIMEOUT || 5_000);
const outputDir = process.env.PLAYWRIGHT_OUTPUT_DIR || 'test-results';
const reportDir = process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || 'playwright-report';
const retainFailureEvidence = process.env.PLAYWRIGHT_DISABLE_FAILURE_EVIDENCE !== '1';
const modelUsageGovernanceSpec = /model-usage-governance\.spec\.mjs/;
const familyModelSettingsSpec = /family-model-settings\.spec\.mjs/;
const authSessionMultitabSpec = /auth-session-multitab\.spec\.mjs/;
const specializedViewportSpecs = /(?:model-usage-governance|family-model-settings|auth-session-multitab)\.spec\.mjs/;
const modelUsageViewportProjects = [
  { name: 'model-usage-360x800', viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true },
  { name: 'model-usage-375x812', viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
  { name: 'model-usage-390x844', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { name: 'model-usage-430x932', viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true },
  { name: 'model-usage-768x1024', viewport: { width: 768, height: 1024 }, hasTouch: true },
  { name: 'model-usage-1024x768', viewport: { width: 1024, height: 768 }, hasTouch: true },
  { name: 'model-usage-1440x900', viewport: { width: 1440, height: 900 } },
].map(({ name, viewport, ...use }) => ({
  name,
  use: { viewport, ...use },
  testMatch: modelUsageGovernanceSpec,
  grep: new RegExp(`@${name}\\b`),
}));
const familyModelSettingsViewportProjects = [
  { name: 'family-model-settings-375x812', viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
  { name: 'family-model-settings-390x844', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  { name: 'family-model-settings-430x932', viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true },
  { name: 'family-model-settings-768x1024', viewport: { width: 768, height: 1024 }, hasTouch: true },
  { name: 'family-model-settings-1024x768', viewport: { width: 1024, height: 768 }, hasTouch: true },
  { name: 'family-model-settings-1440x900', viewport: { width: 1440, height: 900 } },
].map(({ name, viewport, ...use }) => ({
  name,
  use: { viewport, ...use },
  testMatch: familyModelSettingsSpec,
  grep: new RegExp(`@${name}\\b`),
}));

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
      testIgnore: specializedViewportSpecs,
      use: {
        viewport: { width: 375, height: 812 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: 'tablet-1180x820',
      testIgnore: specializedViewportSpecs,
      use: {
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
      },
    },
    {
      name: 'desktop-1440x960',
      testIgnore: specializedViewportSpecs,
      use: {
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: 'auth-session-multitab',
      testMatch: authSessionMultitabSpec,
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
    ...modelUsageViewportProjects,
    ...familyModelSettingsViewportProjects,
  ],
  webServer: {
    command: `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
