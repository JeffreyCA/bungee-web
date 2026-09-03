import { defineConfig } from 'vite';

// Serves bench/web with build/ as the public dir so /sample.wav is reachable.
export default defineConfig({
  root: __dirname,
  publicDir: '../../build',
  server: { port: 5199, strictPort: true, host: '127.0.0.1' },
});
