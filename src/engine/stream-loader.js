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
    
    // High-speed block engine (30s to 1 min forward preload)
    this.blockSize = 2 * 1024 * 1024; // 2 MB per block
    this.targetAheadBlocks = 25; // 50 MB preload ahead (~30 to 45 seconds of 4K video)
    this.maxCachedBlocks = 50; // ~100 MB RAM sliding window
    this.blockCache = new Map(); // blockIndex -> Uint8Array
    this.inFlightRequests = new Map(); // blockIndex -> Promise<Uint8Array>

    this.currentPlaybackByte = 0;
    this.isForwardBuffering = false;
    this.onBufferUpdate = null;
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
   * Starts aggressive forward buffering to preload 30s–1min of video at full bandwidth
   */
  startForwardBuffer(startByte = 0) {
    this.currentPlaybackByte = startByte;
    if (this.isForwardBuffering) return;
    this.isForwardBuffering = true;
    this.runForwardBufferLoop();
  }

  stopForwardBuffer() {
    this.isForwardBuffering = false;
  }

  updatePlaybackPosition(currentByte) {
    this.currentPlaybackByte = Math.max(0, currentByte);
  }

  async runForwardBufferLoop() {
    while (this.isForwardBuffering) {
      const currentBlock = Math.floor(this.currentPlaybackByte / this.blockSize);
      const targetBlock = currentBlock + this.targetAheadBlocks;
      const totalBlocks = this.totalSize > 0 ? Math.ceil(this.totalSize / this.blockSize) : targetBlock + 1;

      // Find the next block that is missing in our forward window
      let nextBlockToFetch = -1;
      for (let b = currentBlock; b <= Math.min(targetBlock, totalBlocks - 1); b++) {
        if (!this.blockCache.has(b) && !this.inFlightRequests.has(b)) {
          nextBlockToFetch = b;
          break;
        }
      }

      if (nextBlockToFetch !== -1) {
        try {
          await this.fetchBlock(nextBlockToFetch);
          if (this.onBufferUpdate) {
            this.onBufferUpdate(this.getBufferedStats(currentBlock));
          }
        } catch (err) {
          console.warn('[RangeStreamLoader] Forward buffer error for block', nextBlockToFetch, err.message);
          await new Promise(r => setTimeout(r, 400));
        }
      } else {
        // Buffer ahead target is fully satisfied! Sleep briefly and monitor playback
        if (this.onBufferUpdate) {
          this.onBufferUpdate(this.getBufferedStats(currentBlock));
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  getBufferedStats(currentBlock = null) {
    const cb = currentBlock !== null ? currentBlock : Math.floor(this.currentPlaybackByte / this.blockSize);
    let contiguousAhead = 0;
    while (this.blockCache.has(cb + contiguousAhead)) {
      contiguousAhead++;
    }
    const bufferedBytes = contiguousAhead * this.blockSize;
    const estSecAhead = Math.round(bufferedBytes / 2100000); // ~2.1 MB/s for 16.8 Mbps 4K
    const bufferedEndByte = (cb + contiguousAhead) * this.blockSize;
    const bufferedEndRatio = this.totalSize > 0 ? Math.min(1, bufferedEndByte / this.totalSize) : 0;

    return {
      bufferedAheadBlocks: contiguousAhead,
      bufferedAheadSec: estSecAhead,
      bufferedEndRatio,
      totalBufferedMB: Math.round((this.blockCache.size * this.blockSize) / (1024 * 1024))
    };
  }

  /**
   * Fetches an aligned 2MB block from the network or memory cache
   */
  async fetchBlock(blockIndex) {
    if (this.blockCache.has(blockIndex)) {
      return this.blockCache.get(blockIndex);
    }

    if (this.inFlightRequests.has(blockIndex)) {
      return this.inFlightRequests.get(blockIndex);
    }

    const start = blockIndex * this.blockSize;
    if (this.totalSize > 0 && start >= this.totalSize) {
      return new Uint8Array(0);
    }

    const end = Math.min(
      start + this.blockSize - 1,
      this.totalSize > 0 ? this.totalSize - 1 : start + this.blockSize - 1
    );

    const promise = (async () => {
      try {
        const res = await fetch(this.streamUrl, {
          headers: { Range: `bytes=${start}-${end}` }
        });

        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status} fetching block ${blockIndex} (${start}-${end})`);
        }

        const buffer = await res.arrayBuffer();
        const data = new Uint8Array(buffer);

        // Manage sliding window memory buffer (evict blocks older than currentBlock - 4)
        if (this.blockCache.size >= this.maxCachedBlocks) {
          const currentBlock = Math.floor(this.currentPlaybackByte / this.blockSize);
          for (const key of this.blockCache.keys()) {
            if (key < currentBlock - 4) {
              this.blockCache.delete(key);
              break;
            }
          }
          // If still over capacity, delete oldest key
          if (this.blockCache.size >= this.maxCachedBlocks) {
            const oldestKey = this.blockCache.keys().next().value;
            this.blockCache.delete(oldestKey);
          }
        }

        this.blockCache.set(blockIndex, data);
        return data;
      } finally {
        this.inFlightRequests.delete(blockIndex);
      }
    })();

    this.inFlightRequests.set(blockIndex, promise);
    return promise;
  }

  /**
   * Fast byte range read from memory block cache
   */
  async readRange(start, end) {
    const totalBytesNeeded = Math.max(0, end - start + 1);
    const result = new Uint8Array(totalBytesNeeded);
    let bytesFilled = 0;

    const startBlock = Math.floor(start / this.blockSize);
    const endBlock = Math.floor(end / this.blockSize);

    this.updatePlaybackPosition(start);

    for (let b = startBlock; b <= endBlock; b++) {
      const blockData = await this.fetchBlock(b);
      const blockStartByte = b * this.blockSize;

      const sliceStart = Math.max(0, start - blockStartByte);
      const sliceEnd = Math.min(blockData.length, end - blockStartByte + 1);

      if (sliceStart < blockData.length && sliceEnd > sliceStart) {
        const chunk = blockData.subarray(sliceStart, sliceEnd);
        result.set(chunk, bytesFilled);
        bytesFilled += chunk.length;
      }
    }

    return result.subarray(0, bytesFilled);
  }
}
