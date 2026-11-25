import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// The companion server (server/index.ts) normally hosts the app on 127.0.0.1:5178,
// using Vite in middleware mode during development. `npm run dev:vite` runs Vite alone.
// Two pages: the director (index.html) and the portrait studio (portrait.html).
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5178, strictPort: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rolldownOptions: { input: { main: page('./index.html'), portrait: page('./portrait.html') } },
  },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
