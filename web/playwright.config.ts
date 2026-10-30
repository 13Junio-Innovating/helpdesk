import { defineConfig, devices } from '@playwright/test';

const WEB = process.env['WEB_URL'] ?? 'http://localhost:5173';

/**
 * E2E no navegador contra a stack real: Postgres (docker compose), API Nest compilada e Vite.
 * Os testes preparam dados pela API/banco e conferem o fluxo pela interface.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // usa o Chromium já instalado no ambiente quando presente
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: process.env['PW_CHROMIUM'] ? { executablePath: process.env['PW_CHROMIUM'] } : {} } },
  ],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../api',
      url: 'http://localhost:3000/api/v1/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        LOG_LEVEL: 'warn',
        // muitos logins seguidos vindos do mesmo IP nos testes
        THROTTLE_AUTH_IP_LIMIT: '10000',
        THROTTLE_AUTH_EMAIL_LIMIT: '10000',
        THROTTLE_DEFAULT_LIMIT: '10000',
      },
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      url: WEB,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
  ],
});
