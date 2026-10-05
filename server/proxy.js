import { isAllowedUrl, maskUrl } from './utils.js';

/**
 * Handles HTTP Range requests with CORS bypassing.
 * Used for initial container header probing (first 2MB) and progressive media byte streaming.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function handleProxy(req, res) {
  try {
    let targetUrl = null;
    const idx = req.url.indexOf('url=');
    if (idx !== -1) {
      targetUrl = decodeURIComponent(req.url.slice(idx + 4));
    }

    if (!targetUrl || !isAllowedUrl(targetUrl)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing, invalid, or forbidden target URL.' }));
      return;
    }

    console.log(`[CORS Proxy] Range proxying: ${maskUrl(targetUrl)}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }

    const forwardHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (req.headers.range) {
      forwardHeaders['Range'] = req.headers.range;
    }

    const response = await fetch(targetUrl, {
      headers: forwardHeaders,
      redirect: 'follow',
    });

    if (!response.ok && response.status !== 206) {
      res.statusCode = response.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: `Upstream storage responded with status ${response.status}: ${response.statusText}. Presigned URL may have expired or is unauthorized.`
      }));
      return;
    }

    res.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
      if (['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();
    let isClosed = false;

    req.on('close', () => {
      isClosed = true;
      try { reader.cancel().catch(() => {}); } catch (e) {}
    });

    try {
      while (!isClosed) {
        const { done, value } = await reader.read();
        if (done || isClosed) break;

        // Handle backpressure
        const canContinue = res.write(value);
        if (!canContinue && !isClosed) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      if (!isClosed) res.end();
    } catch (readErr) {
      // Client disconnected cleanly
    }
  } catch (err) {
    console.error('[CORS Proxy] Stream error:', err.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}
