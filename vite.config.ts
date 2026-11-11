import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The companion server (server/index.ts) normally hosts the app on 127.0.0.1:5178,
// using Vite in middleware mode during development. `npm run dev:vite` runs Vite alone.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1600 },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
