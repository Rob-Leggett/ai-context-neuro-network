import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5319,
    proxy: {
      '/api': 'http://127.0.0.1:4319',
      '/ws': { target: 'ws://127.0.0.1:4319', ws: true },
    },
  },
});
