import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths so the build works from a GitHub Pages sub-path (/feluna/)
  base: './',
  build: { target: 'esnext' },
  esbuild: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
});
