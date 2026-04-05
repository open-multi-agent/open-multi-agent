import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**'],
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // E2E tests require API keys — run with: npm run test:e2e
      ...(process.env['RUN_E2E'] ? [] : ['tests/e2e/**']),
    ],
  },
})
