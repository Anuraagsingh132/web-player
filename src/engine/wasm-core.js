import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

/**
 * WASM Core Media Engine
 * Bridges FFmpeg WASM for container demuxing, stream probing,
 * codec transcoding (AC-3/DTS to multichannel PCM/AAC), and remuxing.
 */
export class WasmCore {
  constructor() {
    this.ffmpeg = null;
    this.isLoaded = false;
    this.isLoading = false;
    this.onProgress = null;
    this.onLog = null;
    this.lastLogs = [];
  }

  async load(onProgress = null) {
    if (this.isLoaded) return true;
    if (this.isLoading) {
      while (this.isLoading) {
        await new Promise(r => setTimeout(r, 100));
      }
      return this.isLoaded;
    }

    this.isLoading = true;
    try {
      this.ffmpeg = new FFmpeg();

      this.ffmpeg.on('log', ({ message }) => {
        this.lastLogs.push(message);
        if (this.lastLogs.length > 200) this.lastLogs.shift();
        if (this.onLog) this.onLog(message);
      });

      this.ffmpeg.on('progress', ({ progress, time }) => {
        if (onProgress) onProgress(progress, time);
        if (this.onProgress) this.onProgress(progress, time);
      });

      // Try local assets in /ffmpeg/ first, fall back to unpkg CDN if needed
      let coreURL, wasmURL;
      try {
        const testRes = await fetch('/ffmpeg/ffmpeg-core.js', { method: 'HEAD' });
        if (testRes.ok) {
          const baseURL = window.location.origin + '/ffmpeg';
          coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
          wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
          console.log('[WasmCore] Using local FFmpeg WASM binaries from /ffmpeg');
        }
      } catch (e) {
        console.warn('[WasmCore] Local binaries not available, falling back to CDN:', e);
      }

      if (!coreURL) {
        const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
        coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
        wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
      }

      await this.ffmpeg.load({ coreURL, wasmURL });
      this.isLoaded = true;
      console.log('[WasmCore] FFmpeg WebAssembly successfully initialized.');
      return true;
    } catch (err) {
      console.error('[WasmCore] Failed to load FFmpeg WASM:', err);
      this.isLoaded = false;
      throw err;
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Safely writes file to FFmpeg WASM filesystem without detaching caller's ArrayBuffer
   */
  async safeWriteFile(name, data) {
    let bytes;
    if (data instanceof Uint8Array) {
      bytes = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.slice(0));
    } else {
      bytes = new Uint8Array(data);
    }
    await this.ffmpeg.writeFile(name, bytes);
  }

  /**
   * Probe media file to extract format and stream metadata
   */
  async probe(fileData, fileName = 'input_file') {
    await this.load();
    this.lastLogs = [];

    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : 'mkv';
    const tempName = `probe_input.${ext}`;

    try {
      await this.safeWriteFile(tempName, fileData);

      // Run ffmpeg -i to capture stream probing output in logs
      try {
        await this.ffmpeg.exec(['-i', tempName]);
      } catch (e) {
        // FFmpeg returns non-zero when no output file is provided; logs still contain metadata!
      }

      const logText = this.lastLogs.join('\n');
      const info = this.parseFFmpegLog(logText, fileName);

      // Cleanup
      await this.ffmpeg.deleteFile(tempName).catch(() => {});

      return info;
    } catch (err) {
      console.error('[WasmCore] Probe error:', err);
      return {
        format: ext.toUpperCase(),
        duration: 0,
        bitrate: 'N/A',
        videoTracks: [],
        audioTracks: [],
        subtitleTracks: []
      };
    }
  }

  /**
   * Parses FFmpeg probe log output into structured track metadata
   */
  parseFFmpegLog(logText, fileName) {
    const info = {
      filename: fileName,
      format: 'Unknown',
      duration: 0,
      durationStr: '00:00:00',
      bitrate: 'N/A',
      videoTracks: [],
      audioTracks: [],
      subtitleTracks: []
    };

    // Extract Duration and Bitrate
    const durationMatch = logText.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?),\s*start:\s*([0-9.]+)?,\s*bitrate:\s*([0-9]+\s*kb\/s)/i);
    if (durationMatch) {
      const h = parseFloat(durationMatch[1]);
      const m = parseFloat(durationMatch[2]);
      const s = parseFloat(durationMatch[3]);
      info.duration = h * 3600 + m * 60 + s;
      info.durationStr = `${durationMatch[1]}:${durationMatch[2]}:${Math.floor(s).toString().padStart(2, '0')}`;
      info.bitrate = durationMatch[5];
    }

    // Extract Input container format
    const formatMatch = logText.match(/Input #0,\s*([^,]+),/i);
    if (formatMatch) {
      info.format = formatMatch[1].trim();
    }

    // Parse all Streams: Stream #0:0(eng): Video/Audio/Subtitle...
    const streamRegex = /Stream #0:(\d+)(?:\(([^)]+)\))?(?:\[0x[0-9a-fA-F]+\])?: (Video|Audio|Subtitle): ([^\n]+)/gi;
    let match;
    while ((match = streamRegex.exec(logText)) !== null) {
      const index = parseInt(match[1], 10);
      const lang = match[2] || 'und';
      const type = match[3].toLowerCase();
      const details = match[4].trim();

      if (type === 'video') {
        // e.g. "hevc (Main 10), yuv420p10le(tv), 3840x2160 [SAR 1:1 DAR 16:9], 23.98 fps, 23.98 tbr"
        const parts = details.split(',').map(s => s.trim());
        const codec = parts[0] || 'Unknown';
        let resolution = 'Unknown';
        let fps = '24';

        const resMatch = details.match(/(\d{3,4}x\d{3,4})/);
        if (resMatch) resolution = resMatch[1];

        const fpsMatch = details.match(/(\d+(?:\.\d+)?)\s*(?:fps|tbr)/);
        if (fpsMatch) fps = fpsMatch[1];

        info.videoTracks.push({
          index,
          lang,
          codec,
          resolution,
          fps,
          details
        });
      } else if (type === 'audio') {
        // e.g. "ac3, 48000 Hz, 5.1(side), fltp, 640 kb/s" or "aac (LC), 48000 Hz, stereo, fltp"
        const parts = details.split(',').map(s => s.trim());
        const codec = parts[0] || 'Unknown';
        let sampleRate = '48000 Hz';
        let channelLayout = 'stereo';
        let channels = 2;

        const srMatch = details.match(/(\d+)\s*Hz/i);
        if (srMatch) sampleRate = `${srMatch[1]} Hz`;

        if (details.includes('5.1') || details.includes('6 channels')) {
          channelLayout = '5.1 Surround';
          channels = 6;
        } else if (details.includes('7.1') || details.includes('8 channels')) {
          channelLayout = '7.1 Surround';
          channels = 8;
        } else if (details.includes('stereo')) {
          channelLayout = 'Stereo (2.0)';
          channels = 2;
        } else if (details.includes('mono')) {
          channelLayout = 'Mono (1.0)';
          channels = 1;
        }

        info.audioTracks.push({
          index,
          lang,
          codec,
          sampleRate,
          channelLayout,
          channels,
          details
        });
      } else if (type === 'subtitle') {
        const codec = details.split(',')[0] || 'srt';
        info.subtitleTracks.push({
          index,
          lang,
          codec,
          details
        });
      }
    }

    return info;
  }

  /**
   * Fast-remux an MKV or container file with H.264/HEVC video:
   * Copies video stream untouched (-c:v copy)
   * Transcodes audio track to AAC 5.1/stereo (-c:a aac)
   * Outputs fragmented MP4 ready for native browser video GPU playback
   */
  async fastRemuxToMP4(fileData, videoTrackIndex = null, audioTrackIndex = null, progressCb = null) {
    await this.load(progressCb);

    const inName = 'remux_in.mkv';
    const outName = 'remux_out.mp4';

    await this.safeWriteFile(inName, fileData);

    const args = ['-i', inName];
    if (videoTrackIndex !== null) {
      args.push('-map', `0:${videoTrackIndex}`);
    } else {
      args.push('-map', '0:v:0?');
    }

    if (audioTrackIndex !== null) {
      args.push('-map', `0:${audioTrackIndex}`);
    } else {
      args.push('-map', '0:a:0?');
    }

    // Video: bitstream copy (zero CPU re-encode, preserve 4K 10-bit HDR)
    args.push('-c:v', 'copy');
    // Audio: transcode to 6-channel AAC for universal browser playback
    args.push('-c:a', 'aac', '-ac', '6', '-b:a', '448k');
    // Fragmented MP4 for immediate browser streaming
    args.push('-movflags', 'faststart');
    args.push('-f', 'mp4', outName);

    console.log('[WasmCore] Executing remux command:', args.join(' '));
    await this.ffmpeg.exec(args);

    const outData = await this.ffmpeg.readFile(outName);

    // Cleanup memory
    await this.ffmpeg.deleteFile(inName).catch(() => {});
    await this.ffmpeg.deleteFile(outName).catch(() => {});

    const blob = new Blob([outData.buffer], { type: 'video/mp4' });
    return URL.createObjectURL(blob);
  }

  /**
   * Decodes an audio stream from any codec (AC-3, E-AC-3, DTS, FLAC, Vorbis)
   * into a multichannel WAV file (16-bit PCM, 6 channels for 5.1)
   */
  async decodeAudioToWav(fileData, audioTrackIndex = null, progressCb = null) {
    await this.load(progressCb);

    const inName = 'audio_in.mkv';
    const outName = 'audio_out.wav';

    await this.safeWriteFile(inName, fileData);

    const args = ['-i', inName];
    if (audioTrackIndex !== null) {
      args.push('-map', `0:${audioTrackIndex}`);
    } else {
      args.push('-map', '0:a:0');
    }

    // Preserve up to 6 channels (5.1) 48kHz 16-bit PCM
    args.push('-vn', '-c:a', 'pcm_s16le', '-f', 'wav', outName);

    console.log('[WasmCore] Executing audio decode:', args.join(' '));
    await this.ffmpeg.exec(args);

    const outData = await this.ffmpeg.readFile(outName);

    // Cleanup
    await this.ffmpeg.deleteFile(inName).catch(() => {});
    await this.ffmpeg.deleteFile(outName).catch(() => {});

    return outData.buffer;
  }
}
