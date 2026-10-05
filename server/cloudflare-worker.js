/**
 * Cloudflare Worker: Zero-Cost, Unlimited-Bandwidth CORS Streamer
 *
 * Deploy this on Cloudflare Workers (Free Plan, 100,000 requests/day, $0 egress fees).
 *
 * How to deploy (2 minutes):
 * 1. Log in to dash.cloudflare.com
 * 2. Go to "Workers & Pages" -> "Create application" -> "Create Worker"
 * 3. Name it (e.g. "cors-streamer") -> Click "Deploy"
 * 4. Click "Edit code" -> Replace all code with this file -> Click "Deploy"
 * 5. Copy your worker URL (e.g. https://cors-streamer.yoursubdomain.workers.dev)
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing ?url= query parameter' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    try {
      // Forward HTTP Range and headers with identity encoding (no compression overhead)
      const forwardHeaders = new Headers();
      forwardHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      forwardHeaders.set('Accept-Encoding', 'identity');

      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        forwardHeaders.set('Range', rangeHeader);
      }

      // Fetch upstream bytes with edge caching enabled for range chunks
      const upstream = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        redirect: 'follow',
        cf: {
          cacheEverything: true,
          cacheTtl: 86400,
        },
      });

      // Prepare response with full CORS permissions and edge caching headers
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', '*');
      responseHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Type');
      responseHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
      responseHeaders.set('Cache-Control', 'public, max-age=86400, s-maxage=86400');

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
