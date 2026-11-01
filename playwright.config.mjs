import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  outputDir: '.dev/browser-results',
  timeout: 45000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 960 }, launchOptions: process.env.LIMEIOT_BROWSER_EXECUTABLE ? { executablePath: process.env.LIMEIOT_BROWSER_EXECUTABLE } : {} },
});
