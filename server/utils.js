import { URL } from 'url';
import { spawn } from 'child_process';

/**
 * Validates URLs against private IP ranges and disallowed protocols (SSRF protection).
 * @param {string} urlString
 * @returns {boolean}
 */
export function isAllowedUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return false;
    if (h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) return false;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Masks sensitive query parameters (e.g. AWS S3/Cloudflare R2 presigned signatures) in server logs.
 * @param {string} urlString
 * @returns {string}
 */
export function maskUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.searchParams.has('X-Amz-Signature')) u.searchParams.set('X-Amz-Signature', '[MASKED]');
    if (u.searchParams.has('X-Amz-Credential')) u.searchParams.set('X-Amz-Credential', '[MASKED]');
    return u.origin + u.pathname + (u.search ? '?' + u.searchParams.toString() : '');
  } catch {
    return (urlString || '').slice(0, 60) + '...';
  }
}

/**
 * Forcefully terminates a child process and its process tree across Windows and POSIX.
 * @param {import('child_process').ChildProcess} p
 */
export function killProcess(p) {
  if (!p) return;
  try {
    if (process.platform === 'win32' && p.pid) {
      spawn('taskkill', ['/pid', String(p.pid), '/t', '/f']);
    } else {
      p.kill('SIGKILL');
    }
  } catch (e) {
    try { p.kill(); } catch (err) {}
  }
}

/** Ignorable network disconnect error codes */
export const IGNORABLE_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ERR_STREAM_PREMATURE_CLOSE'
]);
