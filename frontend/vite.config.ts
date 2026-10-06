import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 21827, host: true },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
});
