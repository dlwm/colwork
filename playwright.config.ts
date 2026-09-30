import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5185',
    viewport: { width: 1400, height: 1000 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {},
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5185 --strictPort',
    url: 'http://127.0.0.1:5185/test/e2e/fixture.html',
    reuseExistingServer: false,
  },
})
