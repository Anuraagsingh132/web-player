import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { URL } from 'url';
import { isAllowedUrl, maskUrl, killProcess } from './utils.js';

/**
 * Legacy standalone audio stream endpoint (MP3/AAC ADTS)
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function handleAudioStream(req, res) {
  let clientDisconnected = false;
  let proc = null;

  const cleanup = () => {
    clientDisconnected = true;
    if (proc) {
      killProcess(proc);
      proc = null;
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
  if (req.socket) req.socket.on('close', cleanup);

  try {
    const reqUrl = new URL(req.url, 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url') || '';
    const track = reqUrl.searchParams.get('track') || '0';
    const seek = reqUrl.searchParams.get('seek') || '0';
    const channels = reqUrl.searchParams.get('ac') || '2';

    if (!targetUrl || !isAllowedUrl(targetUrl)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid or forbidden target URL.' }));
      return;
    }

    console.log(`[Audio Streamer] Streaming audio track ${track} (ac: ${channels}) from ${seek}s: ${maskUrl(targetUrl)}`);

    const isDiscrete51 = String(channels) === '6';
    const contentType = isDiscrete51 ? 'audio/aac' : 'audio/mpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store');

    if (req.method === 'OPTIONS') {
      res.statusCode = 200;
      res.end();
      return;
    }

    if (clientDisconnected) return;

    const seekSec = Math.max(0, parseFloat(seek) || 0);
    const args = [
      '-nostats',
      '-loglevel', 'error',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-headers', 'User-Agent: Mozilla/5.0\r\n',
    ];

    if (seekSec > 0) {
      args.push('-ss', String(seekSec));
    }

    if (isDiscrete51) {
      args.push(
        '-i', targetUrl,
        '-map', `0:a:${track}`,
        '-c:a', 'aac',
        '-b:a', '384k',
        '-ac', '6',
        '-f', 'adts',
        'pipe:1'
      );
    } else {
      args.push(
        '-i', targetUrl,
        '-map', `0:a:${track}`,
        '-c:a', 'libmp3lame',
        '-b:a', '320k',
        '-ac', '2',
        '-f', 'mp3',
        'pipe:1'
      );
    }

    proc = spawn(ffmpegStatic, args);

    proc.stderr.resume();
    proc.stdout.pipe(res);

    proc.on('close', () => {
      if (!res.writableEnded) res.end();
    });

    proc.on('error', (err) => {
      console.error('[Audio Streamer] FFmpeg spawn error:', err.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'FFmpeg transcode failed' }));
      }
    });
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}
