import { defineConfig } from 'vite';
import { registerViteMiddlewares } from './server/routes.js';
import { IGNORABLE_CODES } from './server/utils.js';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    port: 4173,
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@ffmpeg/core', 'libav.js'],
  },
  plugins: [
    {
      name: 'webvlc-media-services',
      configureServer(server) {
        registerViteMiddlewares(server);
      },
    },
  ],
});

// Guard Node from crashing on client connection resets or aborted range requests
process.on('uncaughtException', (err) => {
  if (IGNORABLE_CODES.has(err.code) || err.message?.includes('terminated')) return;
  console.error('[Server UncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  if (IGNORABLE_CODES.has(err?.code) || err?.message?.includes('terminated')) return;
});
