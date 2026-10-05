/**
 * WebVLC Standalone Production Server
 * Serves static build assets and powers real-time Range Proxy,
 * Unified fMP4 Multiplexed Streaming, and Embedded Subtitle Extraction.
 *
 * Usage:
 *   npm run build
 *   node server.js
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dispatchApiRoute } from './server/routes.js';
import { IGNORABLE_CODES } from './server/utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, 'dist');
const PORT = process.env.PORT || 5173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  // Security & Cross-Origin Isolation headers for WebAssembly SharedArrayBuffer
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  // Dispatch Media API Routes (/api/stream, /api/proxy, /api/subtitles, /api/audio-stream)
  const handled = await dispatchApiRoute(req, res);
  if (handled) return;

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = reqUrl.pathname;

  // Static File Serving (from dist/ or project root)
  let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
  } else {
    // Single Page App fallback
    const indexHtml = fs.existsSync(path.join(DIST_DIR, 'index.html'))
      ? path.join(DIST_DIR, 'index.html')
      : path.join(__dirname, 'index.html');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    fs.createReadStream(indexHtml).pipe(res);
  }
});

// Guard Node from exiting on client connection resets or aborted range requests
process.on('uncaughtException', (err) => {
  if (IGNORABLE_CODES.has(err.code) || err.message?.includes('terminated')) return;
  console.error('[Server UncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
  if (IGNORABLE_CODES.has(err?.code) || err?.message?.includes('terminated')) return;
  console.error('[Server UnhandledRejection]', err);
});

server.listen(PORT, () => {
  console.log(`[WebVLC Production Server] Running at http://localhost:${PORT}`);
});
