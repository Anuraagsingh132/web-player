import { handleMuxStream } from './mux-stream.js';
import { handleProxy } from './proxy.js';
import { handleSubtitles } from './subtitles.js';
import { handleAudioStream } from './audio-stream.js';

/**
 * Dispatches incoming HTTP requests to their appropriate API handler.
 * Returns true if the request was an API route handled, or false if not.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @returns {Promise<boolean>}
 */
export async function dispatchApiRoute(req, res) {
  const url = req.url || '';

  if (url.startsWith('/api/stream')) {
    await handleMuxStream(req, res);
    return true;
  }
  if (url.startsWith('/api/proxy')) {
    await handleProxy(req, res);
    return true;
  }
  if (url.startsWith('/api/subtitles')) {
    await handleSubtitles(req, res);
    return true;
  }
  if (url.startsWith('/api/audio-stream')) {
    await handleAudioStream(req, res);
    return true;
  }

  return false;
}

/**
 * Registers all media API endpoints into a Vite dev server.
 * @param {import('vite').ViteDevServer} viteServer
 */
export function registerViteMiddlewares(viteServer) {
  viteServer.middlewares.use(async (req, res, next) => {
    const handled = await dispatchApiRoute(req, res);
    if (!handled) next();
  });
}
