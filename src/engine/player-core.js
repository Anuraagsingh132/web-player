import { AudioEngine } from './audio-engine.js';
import { SubtitleEngine } from './subtitles.js';
import { WasmCore } from './wasm-core.js';
import { RangeStreamLoader } from './stream-loader.js';
import { WebCodecsStreamer } from './webcodecs-streamer.js';

/**
 * Universal Web Player Core
 * Integrates Web Audio API, WebCodecs / HTML5 Video,
 * WASM (FFmpeg) Remuxer/Decoder, and Subtitle Engine.
 */
export class PlayerCore {
  constructor(videoElement, canvasElement) {
    this.videoEl = videoElement;
    this.canvasEl = canvasElement;

    this.audioEngine = new AudioEngine();
    this.subtitleEngine = new SubtitleEngine();
    this.wasmCore = new WasmCore();
    this.webcodecsStreamer = new WebCodecsStreamer(this.canvasEl, this.audioEngine);

    this.webcodecsStreamer.onTimeUpdate = (c, d) => {
      this.currentTime = c;
      this.subtitleEngine.update(c);
      if (this.onTimeUpdate) this.onTimeUpdate(c, d || this.duration);
    };

    this.audioEl = document.getElementById('playerAudio');
    this.currentStreamUrl = null;
    this.activeAudioTrackIndex = 0;
    this.isMuxedStream = false;
    this.seekOffset = 0;
    this.seekDebounceTimer = null;
    this.downmixMode = 'stereo';

    this.currentSource = null; // { type: 'file'|'url', name, data }
    this.metadata = null;
    this.isPlaying = false;
    this.duration = 0;
    this.currentTime = 0;
    this.volume = 1.0;
    this.playbackRate = 1.0;
    this.muted = false;

    this.selectedVideoTrack = null;
    this.selectedAudioTrack = null;
    this.selectedSubtitleTrack = null;

    this.mode = 'hybrid'; // 'hybrid' | 'native' | 'audio-only'
    this.syncRafId = null;

    // Event hooks
    this.onTimeUpdate = null;
    this.onStateChange = null;
    this.onMetadataLoaded = null;
    this.onProgress = null;
    this.onError = null;

    this.setupVideoListeners();
  }

  setupVideoListeners() {
    this.videoEl.addEventListener('timeupdate', () => {
      if (this.mode !== 'audio-only') {
        this.currentTime = this.isMuxedStream
          ? (this.seekOffset || 0) + this.videoEl.currentTime
          : this.videoEl.currentTime;

        this.subtitleEngine.update(this.currentTime);
        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }
      }
    });

    this.videoEl.addEventListener('play', () => {
      this.isPlaying = true;
      if (this.onStateChange) this.onStateChange('playing');
      this.startSyncLoop();
    });

    this.videoEl.addEventListener('pause', () => {
      this.isPlaying = false;
      if (this.onStateChange) this.onStateChange('paused');
      this.stopSyncLoop();
    });

    this.videoEl.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this.onStateChange) this.onStateChange('ended');
      this.stopSyncLoop();
    });
  }

  /**
   * Load media from an ArrayBuffer or File
   */
  async loadMedia(fileData, fileName = 'media_file') {
    try {
      this.stop();
      if (this.onStateChange) this.onStateChange('loading');
      if (this.onProgress) this.onProgress('Probing media streams and codecs...', 10);

      const masterBytes = fileData instanceof Uint8Array
        ? new Uint8Array(fileData.buffer.slice(fileData.byteOffset, fileData.byteOffset + fileData.byteLength))
        : new Uint8Array(fileData.slice ? fileData.slice(0) : fileData);

      this.currentSource = {
        name: fileName,
        data: masterBytes,
        size: masterBytes.byteLength
      };

      // Probe container and streams with WASM Core
      const probeInfo = await this.wasmCore.probe(masterBytes, fileName);
      this.metadata = probeInfo;
      this.duration = probeInfo.duration || 0;

      // Select default tracks
      this.selectedVideoTrack = probeInfo.videoTracks[0] || null;
      this.selectedAudioTrack = probeInfo.audioTracks[0] || null;

      // Setup subtitles if present in metadata or embedded
      this.subtitleEngine.clear();
      if (probeInfo.subtitleTracks && probeInfo.subtitleTracks.length > 0) {
        probeInfo.subtitleTracks.forEach((sub, idx) => {
          this.subtitleEngine.addTrack(
            `Track ${idx + 1} (${sub.lang})`,
            sub.lang,
            '',
            'srt'
          );
        });
      }

      if (this.onMetadataLoaded) {
        this.onMetadataLoaded(this.metadata);
      }

      const isVideo = probeInfo.videoTracks.length > 0;
      const isAC3OrDTS = this.selectedAudioTrack &&
        (this.selectedAudioTrack.codec.toLowerCase().includes('ac3') ||
         this.selectedAudioTrack.codec.toLowerCase().includes('dca') ||
         this.selectedAudioTrack.codec.toLowerCase().includes('dts'));

      const isMKV = fileName.toLowerCase().endsWith('.mkv') ||
                    (probeInfo.format && probeInfo.format.toLowerCase().includes('matroska'));

      if (!isVideo) {
        // Pure Audio File (e.g. AC-3, DTS, WAV, FLAC, MP3)
        this.mode = 'audio-only';
        this.videoEl.style.display = 'none';
        this.canvasEl.style.display = 'none';

        if (this.onProgress) this.onProgress('Decoding multichannel audio with WASM...', 40);
        await this.audioEngine.init();

        let audioBuffer;
        if (isAC3OrDTS || isMKV) {
          const wavBytes = await this.wasmCore.decodeAudioToWav(masterBytes, this.selectedAudioTrack ? this.selectedAudioTrack.index : null);
          audioBuffer = await this.audioEngine.ctx.decodeAudioData(wavBytes);
        } else {
          try {
            audioBuffer = await this.audioEngine.ctx.decodeAudioData(masterBytes.buffer.slice(0));
          } catch (e) {
            // Fallback to WASM WAV decode
            const wavBytes = await this.wasmCore.decodeAudioToWav(masterBytes);
            audioBuffer = await this.audioEngine.ctx.decodeAudioData(wavBytes);
          }
        }

        this.duration = audioBuffer.duration;
        this.audioEngine.setAudioBuffer(audioBuffer);
        if (this.onProgress) this.onProgress('Ready for playback', 100);
        if (this.onStateChange) this.onStateChange('ready');
      } else {
        // Video file (MKV, MP4, etc.)
        this.mode = 'hybrid';
        this.videoEl.style.display = 'block';

        if (isMKV || isAC3OrDTS) {
          if (this.onProgress) this.onProgress('Fast-remuxing container & converting Dolby audio...', 30);

          // Fast remux: preserve 4K / 1080p video packets without re-encoding, transcode audio to 5.1 AAC
          const remuxedUrl = await this.wasmCore.fastRemuxToMP4(
            masterBytes,
            this.selectedVideoTrack ? this.selectedVideoTrack.index : null,
            this.selectedAudioTrack ? this.selectedAudioTrack.index : null,
            (progress) => {
              if (this.onProgress) this.onProgress(`Remuxing: ${Math.round(progress * 100)}%`, 30 + progress * 50);
            }
          );

          this.videoEl.src = remuxedUrl;

          // Also decode audio in background for Web Audio 5.1 VU visualizer
          this.decodeAudioForVisualizer(masterBytes);
        } else {
          // Native MP4 / WebM
          const blob = new Blob([masterBytes.buffer.slice(0)], { type: 'video/mp4' });
          this.videoEl.src = URL.createObjectURL(blob);
          this.decodeAudioForVisualizer(masterBytes);
        }

        this.videoEl.load();
        if (this.onProgress) this.onProgress('Ready for playback', 100);
        if (this.onStateChange) this.onStateChange('ready');
      }
    } catch (err) {
      console.error('[PlayerCore] Media load error:', err);
      if (this.onError) this.onError(err.message || 'Failed to load and demux media file.');
      if (this.onStateChange) this.onStateChange('error');
    }
  }

  /**
   * Real-Time Stream URL without downloading the entire file
   * Reads only 2MB for header metadata probing, then streams byte ranges on demand
   */
  async loadStreamUrl(url, fileName = 'stream_media') {
    try {
      this.stop();
      if (this.onStateChange) this.onStateChange('loading');
      if (this.onProgress) this.onProgress('Initializing real-time HTTP Range stream...', 10);

      const loader = new RangeStreamLoader(url);
      const streamInfo = await loader.init();

      if (this.onProgress) this.onProgress('Probing media headers via Range request (first 2MB)...', 25);
      // Fetch only the first 2MB to probe container & stream metadata
      const headerBytes = await loader.readRange(
        0,
        Math.min(2 * 1024 * 1024 - 1, streamInfo.totalSize ? streamInfo.totalSize - 1 : 2097151)
      );

      const probeInfo = await this.wasmCore.probe(headerBytes, fileName);
      if (streamInfo.totalSize > 0) {
        const decGB = (streamInfo.totalSize / 1e9).toFixed(2);
        const binGiB = (streamInfo.totalSize / (1024 ** 3)).toFixed(2);
        probeInfo.fileSizeStr = `${decGB} GB (${binGiB} GiB)`;
      }
      this.metadata = probeInfo;
      this.duration = probeInfo.duration || 0;

      // Check HEVC / H.265 hardware support (Issue 22)
      const hasHevc = probeInfo.videoTracks.some(t => t.codec && (t.codec.toLowerCase().includes('hevc') || t.codec.toLowerCase().includes('h265')));
      if (hasHevc && !this.checkHevcSupport()) {
        console.warn('[PlayerCore] Browser/GPU does not report native HEVC hardware decoder support.');
        if (this.onWarning) this.onWarning('HEVC / H.265 stream: If video appears black, your browser may require HEVC hardware acceleration enabled.');
      }

      this.selectedVideoTrack = probeInfo.videoTracks[0] || null;
      this.selectedAudioTrack = probeInfo.audioTracks[0] || null;

      // Setup subtitles
      this.subtitleEngine.clear();
      if (probeInfo.subtitleTracks && probeInfo.subtitleTracks.length > 0) {
        probeInfo.subtitleTracks.forEach((sub, idx) => {
          this.subtitleEngine.addTrack(`Track ${idx + 1} (${sub.lang})`, sub.lang, '', 'srt');
        });
      }

      if (this.onMetadataLoaded) {
        this.onMetadataLoaded(this.metadata);
      }

      const isVideo = probeInfo.videoTracks.length > 0;
      const isServerAvailable = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

      if (isVideo) {
        if (isServerAvailable) {
          this.mode = 'hybrid';
          this.isMuxedStream = true;
          this.seekOffset = 0;
          this.videoEl.style.display = 'block';
          this.canvasEl.style.display = 'none';
          if (this.onProgress) this.onProgress('Connected real-time fMP4 video stream.', 85);

          this.currentStreamUrl = url;
          this.activeAudioTrackIndex = 0;

          if (this.audioEl) {
            this.audioEl.pause();
            this.audioEl.removeAttribute('src');
          }

          const channels = this.downmixMode === 'discrete' ? '6' : '2';
          const vcodec = hasHevc ? 'hevc' : 'copy';

          // Calculate media bitrate (e.g. 18.28GB / 8100s * 8 = ~18,000,000 bps)
          let estBitrate = 20000000;
          if (streamInfo.totalSize > 0 && this.duration > 0) {
            estBitrate = Math.round((streamInfo.totalSize * 8) / this.duration);
          }
          this.estimatedBitrate = estBitrate;

          // Connect video element to unified multiplexed fMP4 stream with rate pacing
          this.videoEl.src = `/api/stream?url=${encodeURIComponent(url)}&track=0&seek=0&ac=${channels}&vcodec=${vcodec}&bitrate=${estBitrate}`;
          this.videoEl.muted = false;
          this.videoEl.load();

          // Connect Web Audio API to the video element for gain boost, Pro Logic II, and VU meters
          await this.audioEngine.init();
          this.audioEngine.connectMediaElement(this.videoEl, parseInt(channels, 10));
        } else {
          const isMKV = (fileName && fileName.toLowerCase().endsWith('.mkv')) ||
                        (probeInfo.formatName && probeInfo.formatName.toLowerCase().includes('matroska'));
          const isAC3OrDTS = probeInfo.audioTracks.some(t => {
            const c = (t.codec || '').toLowerCase();
            return c.includes('ac3') || c.includes('eac3') || c.includes('dts') || c.includes('truehd');
          });

          if (!isMKV && !isAC3OrDTS) {
            // Native HTML5 progressive streaming via CORS Edge Worker (zero server bandwidth)
            this.mode = 'hybrid';
            this.isMuxedStream = false;
            this.seekOffset = 0;
            this.videoEl.style.display = 'block';
            this.canvasEl.style.display = 'none';
            if (this.onProgress) this.onProgress('Connected hardware HTML5 video stream via CORS Edge.', 85);

            this.currentStreamUrl = url;
            this.videoEl.src = loader.streamUrl;
            this.videoEl.muted = false;
            this.videoEl.load();

            await this.audioEngine.init();
            this.audioEngine.connectMediaElement(this.videoEl, 2);
          } else {
            // Pure in-browser WebCodecs mode for MKV & Dolby AC-3 / DTS (0 server bandwidth)
            this.mode = 'webcodecs';
            this.isMuxedStream = false;
            this.videoEl.style.display = 'none';
            this.canvasEl.style.display = 'block';
            if (this.onProgress) this.onProgress('Connected in-browser WebCodecs hardware stream.', 85);

            this.currentStreamUrl = url;
            await this.webcodecsStreamer.load(url, fileName);
          }
        }
      } else {
        this.mode = 'audio-only';
        this.videoEl.style.display = 'none';
        this.canvasEl.style.display = 'none';
        if (this.onProgress) this.onProgress('Decoding audio stream with WebAssembly...', 60);
        await this.audioEngine.init();
        const wavBytes = await this.wasmCore.decodeAudioToWav(headerBytes);
        const audioBuffer = await this.audioEngine.ctx.decodeAudioData(wavBytes);
        this.duration = audioBuffer.duration;
        this.audioEngine.setAudioBuffer(audioBuffer);
      }

      if (this.onProgress) this.onProgress('Ready for real-time playback', 100);
      if (this.onStateChange) this.onStateChange('ready');
    } catch (err) {
      console.error('[PlayerCore] Stream load error:', err);
      if (this.onError) this.onError(err.message || 'Failed to stream media.');
      if (this.onStateChange) this.onStateChange('error');
    }
  }

  checkHevcSupport() {
    const v = document.createElement('video');
    return !!(
      v.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
      v.canPlayType('video/mp4; codecs="hevc"') ||
      v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"')
    );
  }

  loadMuxedAt(targetSeconds) {
    if (!this.currentStreamUrl) return;
    const wasPlaying = this.isPlaying;
    const safeTarget = Math.max(0, Math.min(targetSeconds, this.duration || 0));
    this.seekOffset = safeTarget;
    this.currentTime = safeTarget;
    if (this.onTimeUpdate) this.onTimeUpdate(safeTarget, this.duration);
    this.subtitleEngine.update(safeTarget);

    const hasHevc = this.metadata && this.metadata.videoTracks && this.metadata.videoTracks.some(
      t => t.codec && (t.codec.toLowerCase().includes('hevc') || t.codec.toLowerCase().includes('h265'))
    );
    const vcodec = hasHevc ? 'hevc' : 'copy';
    const channels = this.downmixMode === 'discrete' ? '6' : '2';
    const bitrate = this.estimatedBitrate || 20000000;

    this.videoEl.src = `/api/stream?url=${encodeURIComponent(this.currentStreamUrl)}&track=${this.activeAudioTrackIndex}&seek=${safeTarget}&ac=${channels}&vcodec=${vcodec}&bitrate=${bitrate}`;
    this.videoEl.muted = false;
    this.videoEl.load();

    if (wasPlaying) {
      this.videoEl.play().catch(() => {});
    }
  }

  switchAudioTrack(index) {
    this.activeAudioTrackIndex = index;
    if (this.isMuxedStream && this.currentStreamUrl) {
      const cur = (this.seekOffset || 0) + (this.videoEl ? this.videoEl.currentTime : 0);
      console.log(`[PlayerCore] Switching to audio track ${index} at timestamp ${cur.toFixed(1)}s...`);
      this.loadMuxedAt(cur);
    }
  }

  async decodeAudioForVisualizer(fileData) {
    try {
      await this.audioEngine.init();
      const wavBytes = await this.wasmCore.decodeAudioToWav(
        fileData,
        this.selectedAudioTrack ? this.selectedAudioTrack.index : null
      );
      const audioBuffer = await this.audioEngine.ctx.decodeAudioData(wavBytes);
      this.audioEngine.setAudioBuffer(audioBuffer);
    } catch (e) {
      console.warn('[PlayerCore] Background audio visualizer decode skipped:', e);
    }
  }

  async play() {
    await this.audioEngine.init();

    if (this.mode === 'audio-only') {
      this.audioEngine.play();
      this.isPlaying = true;
      if (this.onStateChange) this.onStateChange('playing');
      this.startSyncLoop();
    } else if (this.mode === 'webcodecs') {
      this.webcodecsStreamer.play();
      this.isPlaying = true;
      if (this.onStateChange) this.onStateChange('playing');
    } else {
      if (this.isMuxedStream) {
        this.audioEngine.connectMediaElement(this.videoEl, this.downmixMode === 'discrete' ? 6 : 2);
      }
      await this.videoEl.play().catch(err => {
        if (err.name !== 'AbortError') console.warn('[PlayerCore] Play warning:', err.message);
      });
      this.isPlaying = true;
      if (this.onStateChange) this.onStateChange('playing');
      this.startSyncLoop();
      if (this.audioEngine.currentAudioBuffer) {
        this.audioEngine.play(this.videoEl.currentTime);
      }
    }
  }

  pause() {
    this.isPlaying = false;
    if (this.mode === 'audio-only') {
      this.audioEngine.pause();
    } else if (this.mode === 'webcodecs') {
      this.webcodecsStreamer.pause();
    } else {
      this.videoEl.pause();
      this.audioEngine.pause();
    }
    if (this.onStateChange) this.onStateChange('paused');
    this.stopSyncLoop();
  }

  stop() {
    this.isStopping = true;
    this.isPlaying = false;
    if (this.seekDebounceTimer) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
    this.isMuxedStream = false;
    this.seekOffset = 0;
    this.currentTime = 0;
    this.audioEngine.stop();
    if (this.webcodecsStreamer) {
      this.webcodecsStreamer.stop();
    }
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.removeAttribute('src');
    }
    if (this.videoEl) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
    }
    this.stopSyncLoop();
    if (this.onTimeUpdate) this.onTimeUpdate(0, this.duration);
    if (this.onStateChange) this.onStateChange('stopped');
    setTimeout(() => { this.isStopping = false; }, 200);
  }

  seek(seconds) {
    const target = Math.max(0, Math.min(seconds, this.duration));
    this.currentTime = target;

    if (this.mode === 'audio-only') {
      this.audioEngine.seek(target);
      this.subtitleEngine.update(target);
      if (this.onTimeUpdate) this.onTimeUpdate(target, this.duration);
    } else if (this.isMuxedStream) {
      if (this.seekDebounceTimer) clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = setTimeout(() => {
        this.loadMuxedAt(target);
      }, 150);
    } else {
      this.videoEl.currentTime = target;
      if (this.audioEngine.currentAudioBuffer) {
        this.audioEngine.seek(target);
      }
    }
  }

  setVolume(vol) {
    this.volume = vol;
    this.audioEngine.setVolume(vol);
    if (this.audioEl) {
      this.audioEl.volume = 1.0;
    }
    if (this.isMuxedStream && this.videoEl) {
      this.videoEl.volume = 1.0;
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.audioEngine.setMuted(muted);
    if (this.audioEl) {
      this.audioEl.muted = false;
    }
    if (this.isMuxedStream && this.videoEl) {
      this.videoEl.muted = false;
    }
  }

  setPlaybackRate(rate) {
    this.playbackRate = rate;
    this.audioEngine.setPlaybackRate(rate);
    if (this.videoEl) {
      this.videoEl.playbackRate = rate;
    }
    if (this.audioEl) {
      this.audioEl.playbackRate = rate;
    }
  }

  setDownmixMode(mode) {
    this.downmixMode = mode;
    this.audioEngine.setDownmixMode(mode);
    if (this.isMuxedStream && this.currentStreamUrl) {
      const cur = (this.seekOffset || 0) + (this.videoEl ? this.videoEl.currentTime : 0);
      this.loadMuxedAt(cur);
    }
  }

  startSyncLoop() {
    this.stopSyncLoop();
    const tick = () => {
      if (this.mode === 'audio-only' && this.isPlaying) {
        this.currentTime = this.audioEngine.getCurrentTime();
        this.subtitleEngine.update(this.currentTime);
        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }
      }
      this.syncRafId = requestAnimationFrame(tick);
    };
    this.syncRafId = requestAnimationFrame(tick);
  }

  stopSyncLoop() {
    if (this.syncRafId) {
      cancelAnimationFrame(this.syncRafId);
      this.syncRafId = null;
    }
  }

  getVULevels() {
    return this.audioEngine.getVULevels();
  }
}
