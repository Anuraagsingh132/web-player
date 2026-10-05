/**
 * HTTP Range Request Streaming Loader
 * Enables streaming multi-gigabyte media (such as 18GB 4K MKV files) in real-time
 * without downloading the entire file into memory.
 */

export const DEFAULT_WORKER_URL = 'https://little-bonus-321e.anuraagsingh10a.workers.dev';

export class RangeStreamLoader {
  constructor(url, options = {}) {
    this.rawUrl = url;
    this.options = options;
    this.totalSize = 0;
    this.acceptsRanges = false;
    this.contentType = '';
    this.streamUrl = '';
    this.chunkCache = new Map(); // Small LRU cache for frequently read headers
  }

  /**
   * Initializes stream, checks HTTP Range capability and gets total size
   */
  async init() {
    // If it's a remote URL, route through local proxy or Cloudflare Worker to avoid CORS restrictions
    if (this.rawUrl.startsWith('http://') || this.rawUrl.startsWith('https://')) {
      const isAlreadyProxied = this.rawUrl.includes('/api/proxy?url=') ||
                               this.rawUrl.includes('corsproxy.io') ||
                               this.rawUrl.includes('workers.dev');
      if (!isAlreadyProxied) {
        const customWorker = localStorage.getItem('webvlc_cors_worker');
        const activeWorker = customWorker || DEFAULT_WORKER_URL;

        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          this.streamUrl = `/api/proxy?url=${encodeURIComponent(this.rawUrl)}`;
        } else {
          this.streamUrl = `${activeWorker.replace(/\/$/, '')}?url=${encodeURIComponent(this.rawUrl)}`;
        }
      } else {
        this.streamUrl = this.rawUrl;
      }
    } else {
      this.streamUrl = this.rawUrl;
    }

    try {
      // Fetch initial probe bytes (0 to 1024) to inspect headers and Content-Range
      const res = await fetch(this.streamUrl, {
        headers: { Range: 'bytes=0-1024' }
      });

      if (!res.ok && res.status !== 206) {
        throw new Error(`Server returned HTTP ${res.status} ${res.statusText}`);
      }

      const contentRange = res.headers.get('content-range');
      const contentLength = res.headers.get('content-length');
      this.contentType = res.headers.get('content-type') || 'application/octet-stream';
      this.acceptsRanges = res.status === 206 || (res.headers.get('accept-ranges') === 'bytes');

      if (contentRange) {
        // e.g. "bytes 0-1024/18287845270"
        const parts = contentRange.split('/');
        if (parts[1] && parts[1] !== '*') {
          this.totalSize = parseInt(parts[1], 10);
        }
      } else if (contentLength) {
        this.totalSize = parseInt(contentLength, 10);
      }

      console.log(`[RangeStreamLoader] Initialized stream. Size: ${(this.totalSize / 1024 / 1024 / 1024).toFixed(2)} GB, Range Support: ${this.acceptsRanges}`);
      return {
        totalSize: this.totalSize,
        acceptsRanges: this.acceptsRanges,
        contentType: this.contentType,
        streamUrl: this.streamUrl
      };
    } catch (err) {
      console.warn('[RangeStreamLoader] Initial range check error, falling back to direct:', err);
      this.streamUrl = this.rawUrl;
      return {
        totalSize: 0,
        acceptsRanges: false,
        contentType: 'application/octet-stream',
        streamUrl: this.streamUrl
      };
    }
  }

  /**
   * Fetches only a specific byte range (e.g. 0 to 2MB for header metadata)
   */
  async readRange(start, end) {
    const cacheKey = `${start}-${end}`;
    if (this.chunkCache.has(cacheKey)) {
      return this.chunkCache.get(cacheKey);
    }

    const res = await fetch(this.streamUrl, {
      headers: { Range: `bytes=${start}-${end}` }
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`Failed to read byte range ${start}-${end}: HTTP ${res.status}`);
    }

    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Keep small cache (max 10 entries)
    if (this.chunkCache.size > 10) {
      const firstKey = this.chunkCache.keys().next().value;
      this.chunkCache.delete(firstKey);
    }
    this.chunkCache.set(cacheKey, bytes);

    return bytes;
  }
}
