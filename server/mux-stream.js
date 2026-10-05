import ffmpegStatic from 'ffmpeg-static';
import { spawn } from 'child_process';
import { URL } from 'url';
import { Transform } from 'stream';
import { isAllowedUrl, maskUrl, killProcess } from './utils.js';

// Singleton active streaming process reference
let activeStreamProcess = null;

/**
 * Intelligent Bandwidth-Pacing Transform Stream
 * - Phase 1: Fast initial burst (e.g. 20-30MB) delivered with 0 delay to start playback in <1s.
 * - Phase 2: Smooth pacing locked at ~1.35x real-time media bitrate (~25-28 Mbps for 4K).
 * Prevents network saturation (120-140 Mbps spikes), eliminates router bufferbloat,
 * stops Cloudflare R2 TCP connection freezes, and prevents wasting bandwidth.
 */
class ThrottleStream extends Transform {
  constructor(burstBytes, bytesPerSec) {
    super();
    this.burstBytes = burstBytes;
    this.bytesPerSec = bytesPerSec;
    this.totalSent = 0;
    this.burstCompletedAt = 0;
    this.postBurstBytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.totalSent += chunk.length;

    // Phase 1: Initial fast buffer fill
    if (this.totalSent <= this.burstBytes) {
      this.push(chunk);
      return callback();
    }

    // Phase 2: Steady state pacing (1.35x playback speed)
    if (!this.burstCompletedAt) {
      this.burstCompletedAt = Date.now();
    }

    this.postBurstBytes += chunk.length;
    const expectedElapsedMs = (this.postBurstBytes / this.bytesPerSec) * 1000;
    const actualElapsedMs = Date.now() - this.burstCompletedAt;
    const delayMs = expectedElapsedMs - actualElapsedMs;

    if (delayMs > 25) {
      setTimeout(() => {
        this.push(chunk);
        callback();
      }, Math.min(delayMs, 400));
    } else {
      this.push(chunk);
      callback();
    }
  }
}

/**
 * Real-time multiplexed streaming endpoint
 * Remuxes video (via stream-copy) and audio (transcoded to AAC) into a single fragmented MP4.
 * Features rate-pacing, singleton process management, and jitter-buffered demuxing.
 */
export async function handleMuxStream(req, res) {
  let clientDisconnected = false;
  let proc = null;
  let throttle = null;

  // Kill any prior running FFmpeg process immediately (prevent multiple streams from competing)
  if (activeStreamProcess) {
    killProcess(activeStreamProcess);
    activeStreamProcess = null;
  }

  const cleanup = () => {
    if (clientDisconnected) return;
    clientDisconnected = true;
    if (throttle) {
      try { throttle.destroy(); } catch (e) {}
      throttle = null;
    }
    if (proc) {
      if (activeStreamProcess === proc) activeStreamProcess = null;
      killProcess(proc);
      proc = null;
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  if (req.socket) req.socket.on('close', cleanup);

  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const targetUrl = parsedUrl.searchParams.get('url');
    const track = parseInt(parsedUrl.searchParams.get('track') || '0', 10);
    const seek = parseFloat(parsedUrl.searchParams.get('seek') || '0');
    const ac = parsedUrl.searchParams.get('ac') || '2';
    const vcodec = (parsedUrl.searchParams.get('vcodec') || 'hevc').toLowerCase();
    const rawBitrate = parseInt(parsedUrl.searchParams.get('bitrate') || '20000000', 10);
    const bitrate = Math.max(2000000, Math.min(rawBitrate, 80000000)); // 2 Mbps to 80 Mbps clamp

    if (!targetUrl || !isAllowedUrl(targetUrl)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing or forbidden url parameter' }));
      return;
    }

    const seekSec = Math.max(0, seek || 0);
    const is51 = (ac === '6');

    // Calculate smart rate pacing parameters
    const mediaBytesPerSec = Math.max(1.5 * 1024 * 1024, Math.round(bitrate / 8));
    const burstBytes = Math.max(22 * 1024 * 1024, mediaBytesPerSec * 10); // ~10 seconds initial buffer
    const pacingBytesPerSec = Math.round(mediaBytesPerSec * 1.35); // 1.35x real-time playback speed

    console.log(`[Mux Streamer] Starting fMP4 stream: ${maskUrl(targetUrl)} (Track: ${track}, Seek: ${seekSec.toFixed(1)}s, Pacing: ${(pacingBytesPerSec * 8 / 1e6).toFixed(1)} Mbps)`);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }

    if (clientDisconnected) return;

    // Robust network demuxer flags: removed +nobuffer+discardcorrupt which caused frame dropping and stutter
    const args = [
      '-nostats',
      '-loglevel', 'error',
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-headers', 'User-Agent: Mozilla/5.0\r\n',
      '-fflags', '+fastseek+genpts',
      '-max_delay', '500000',
      '-probesize', '1000000',
      '-analyzeduration', '1000000',
    ];

    if (seekSec > 0) {
      args.push('-ss', String(seekSec));
      args.push('-noaccurate_seek');
    }

    args.push('-i', targetUrl);

    // Video: Stream copy (0 CPU cost)
    args.push('-map', '0:v:0');
    args.push('-c:v', 'copy');

    if (vcodec.includes('hevc') || vcodec.includes('h265')) {
      args.push('-tag:v', 'hvc1');
    }

    // Audio: Transcode to AAC (stereo or 5.1)
    args.push('-map', `0:a:${track}`);
    args.push('-c:a', 'aac');
    args.push('-b:a', is51 ? '384k' : '256k');
    args.push('-ac', is51 ? '6' : '2');

    // Mux into streaming fragmented MP4 with clean timestamp alignment
    args.push(
      '-avoid_negative_ts', 'make_zero',
      '-max_muxing_queue_size', '2048',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );

    proc = spawn(ffmpegStatic, args);
    activeStreamProcess = proc;

    proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn('[Mux Streamer stderr]:', msg);
    });

    // Create paced pipeline with automatic backpressure
    throttle = new ThrottleStream(burstBytes, pacingBytesPerSec);
    proc.stdout.pipe(throttle).pipe(res);

    proc.on('close', () => {
      if (activeStreamProcess === proc) activeStreamProcess = null;
      if (!res.writableEnded) res.end();
    });

    proc.on('error', (err) => {
      console.error('[Mux Streamer] FFmpeg spawn error:', err.message);
      if (activeStreamProcess === proc) activeStreamProcess = null;
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'FFmpeg stream failed' }));
      }
    });
  } catch (err) {
    console.error('[Mux Streamer] Handler error:', err.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}
