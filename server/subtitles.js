import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import { URL } from 'url';
import { isAllowedUrl, killProcess } from './utils.js';

/**
 * Extracts embedded subtitle tracks (SRT/ASS/VobSub) from remote MKV/MP4 files as WebVTT on demand.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
export async function handleSubtitles(req, res) {
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

  try {
    const reqUrl = new URL(req.url, 'http://localhost');
    const targetUrl = reqUrl.searchParams.get('url') || '';
    const track = reqUrl.searchParams.get('track') || '0';

    if (!targetUrl || !isAllowedUrl(targetUrl)) {
      res.statusCode = 400;
      res.end('Invalid URL');
      return;
    }

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (clientDisconnected) return;

    proc = spawn(ffmpegStatic, [
      '-nostats',
      '-loglevel', 'error',
      '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-headers', 'User-Agent: Mozilla/5.0\r\n',
      '-i', targetUrl,
      '-map', `0:s:${track}`,
      '-f', 'webvtt',
      'pipe:1'
    ]);

    proc.stderr.resume();
    proc.stdout.pipe(res);

    proc.on('close', () => {
      if (!res.writableEnded) res.end();
    });

    proc.on('error', () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('WEBVTT\n\n');
      }
    });
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('WEBVTT\n\n');
    }
  }
}
