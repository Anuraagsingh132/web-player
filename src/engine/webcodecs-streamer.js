import LibAV from 'libav.js';
import * as Bridge from 'libavjs-webcodecs-bridge';
import { RangeStreamLoader } from './stream-loader.js';

/**
 * Real-Time WebCodecs + Web Audio API MKV Streaming Engine
 * Demuxes MKV/MP4 containers via libav.js block device (HTTP Range requests).
 * Decodes 4K HEVC/H.264 via hardware WebCodecs VideoDecoder -> Canvas.
 * Decodes AC-3 / E-AC-3 / DTS / AAC audio via WASM / WebCodecs -> Web Audio API 5.1 surround sound.
 */
export class WebCodecsStreamer {
  constructor(canvas, audioEngine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.audioEngine = audioEngine;

    this.libav = null;
    this.loader = null;
    this.fmt_ctx = null;
    this.videoStream = null;
    this.audioStream = null;
    this.videoDecoder = null;
    this.audioDecoder = null;

    // Software audio decoder fallback for Dolby AC-3/E-AC-3
    this.audioCodecCtx = null;
    this.audioPkt = null;
    this.audioFrame = null;
    this.demuxPkt = null;

    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;
    this.totalSize = 0;
    this.metadata = null;

    this.videoFrameQueue = [];
    this.renderLoopId = null;
    this.demuxLoopRunning = false;

    // Hooks
    this.onTimeUpdate = null;
    this.onStateChange = null;
    this.onMetadataLoaded = null;
    this.onError = null;
  }

  async initLibAV() {
    if (this.libav) return;

    LibAV.base = window.location.origin + '/libav';
    console.log('[WebCodecsStreamer] Initializing LibAV WASM from base:', LibAV.base);
    this.libav = await LibAV.LibAV({ noworker: true });
    this.demuxPkt = await this.libav.av_packet_alloc();
  }

  /**
   * Connects to a streaming URL and initializes demuxer via block device
   */
  async load(url, fileName = 'stream.mkv') {
    this.stop();
    if (this.onStateChange) this.onStateChange('loading');

    this.loader = new RangeStreamLoader(url);
    const info = await this.loader.init();
    this.totalSize = info.totalSize || 0;

    await this.initLibAV();

    // Setup virtual block device with HTTP Range requests
    const devName = 'stream_input_' + Date.now();
    this.libav.onblockread = async (name, pos, length) => {
      try {
        const readLen = Math.min(length || 64 * 1024, (this.totalSize ? this.totalSize - pos : 128 * 1024));
        const bytes = await this.loader.readRange(pos, pos + readLen - 1);
        await this.libav.ff_block_reader_dev_send(name, pos, bytes);
      } catch (err) {
        console.error('[WebCodecsStreamer] Block read error:', err);
      }
    };

    console.log(`[WebCodecsStreamer] Creating block reader dev: ${devName}, size: ${this.totalSize}`);
    await this.libav.mkblockreaderdev(devName, this.totalSize);

    // Initialize demuxer on virtual device
    const [fmt_ctx, streams] = await this.libav.ff_init_demuxer_file(devName);
    this.fmt_ctx = fmt_ctx;

    // Find video and audio streams
    for (const s of streams) {
      if (s.codec_type === this.libav.AVMEDIA_TYPE_VIDEO && !this.videoStream) {
        this.videoStream = s;
      } else if (s.codec_type === this.libav.AVMEDIA_TYPE_AUDIO && !this.audioStream) {
        this.audioStream = s;
      }
    }

    // Probing metadata
    this.metadata = {
      filename: fileName,
      format: 'Matroska (MKV)',
      totalSizeStr: `${(this.totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`,
      videoTracks: [],
      audioTracks: []
    };

    if (this.videoStream) {
      console.log('[WebCodecsStreamer] Converting video stream to WebCodecs config with LibAV...');
      const vConfig = await Bridge.videoStreamToConfig(this.libav, this.videoStream);
      console.log('[WebCodecsStreamer] Bridge video config:', vConfig);

      if (!vConfig || !vConfig.codec) {
        throw new Error('Could not extract valid WebCodecs video configuration from stream.');
      }

      this.canvas.width = vConfig.codedWidth || 1920;
      this.canvas.height = vConfig.codedHeight || 1080;

      this.metadata.videoTracks.push({
        codec: vConfig.codec,
        resolution: `${this.canvas.width}x${this.canvas.height}`,
        fps: '23.98',
        details: `Codec: ${vConfig.codec}`
      });

      // Initialize WebCodecs VideoDecoder
      await this.initVideoDecoder(vConfig);
    }

    if (this.audioStream) {
      try {
        await this.audioEngine.init();
        let audioCodecName = 'Audio';
        try {
          audioCodecName = await this.libav.avcodec_get_name(this.audioStream.codec_id);
        } catch (e) {}

        const ch = this.audioStream.channels || 6;
        const sr = this.audioStream.sample_rate || 48000;

        // Try WebCodecs native AudioDecoder first (hardware accelerated & Dolby compatible)
        let aConfig = null;
        try {
          aConfig = await Bridge.audioStreamToConfig(this.libav, this.audioStream);
        } catch (e) {}

        if (!aConfig || !aConfig.codec || aConfig.codec === 'unknown') {
          const cLower = (audioCodecName || '').toLowerCase();
          if (cLower === 'eac3') aConfig = { codec: 'ec-3', sampleRate: sr, numberOfChannels: ch };
          else if (cLower === 'ac3') aConfig = { codec: 'ac-3', sampleRate: sr, numberOfChannels: ch };
          else if (cLower === 'aac') aConfig = { codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: ch };
          else if (cLower === 'opus') aConfig = { codec: 'opus', sampleRate: sr, numberOfChannels: ch };
          else if (cLower === 'flac') aConfig = { codec: 'flac', sampleRate: sr, numberOfChannels: ch };
        }

        let audioDecoderSupported = false;
        if (aConfig && aConfig.codec && typeof AudioDecoder !== 'undefined') {
          try {
            const check = await AudioDecoder.isConfigSupported(aConfig);
            if (check && check.supported) {
              audioDecoderSupported = true;
              this.audioDecoder = new AudioDecoder({
                output: (audioData) => this.scheduleAudioData(audioData),
                error: (e) => console.warn('[WebCodecsStreamer] AudioDecoder error:', e)
              });
              this.audioDecoder.configure(aConfig);
              console.log('[WebCodecsStreamer] Native AudioDecoder configured successfully:', aConfig.codec);
            }
          } catch (e) {
            // Fall back to software decoder
          }
        }

        // Fallback to WASM software decoder if available
        if (!audioDecoderSupported) {
          try {
            const [, c, p, f] = await this.libav.ff_init_decoder(this.audioStream.codec_id, this.audioStream.codecpar);
            this.audioCodecCtx = c;
            this.audioPkt = p;
            this.audioFrame = f;
            console.log('[WebCodecsStreamer] Software audio decoder initialized for:', audioCodecName);
          } catch (err) {
            console.warn('[WebCodecsStreamer] Software audio decoder unavailable for:', audioCodecName);
          }
        }

        this.metadata.audioTracks.push({
          codec: (audioCodecName || 'Dolby Audio').toUpperCase(),
          channels: ch,
          channelLayout: ch === 6 ? '5.1 Surround' : 'Stereo',
          sampleRate: `${sr} Hz`
        });
      } catch (err) {
        console.warn('[WebCodecsStreamer] Audio initialization error:', err);
      }
    }

    if (this.onMetadataLoaded) this.onMetadataLoaded(this.metadata);
    if (this.onStateChange) this.onStateChange('ready');
  }

  async initVideoDecoder(config) {
    if (!config || !config.codec) {
      throw new Error('VideoDecoder requires a valid codec configuration.');
    }

    console.log('[WebCodecsStreamer] Initializing VideoDecoder with config:', config);

    // Candidates to test with VideoDecoder
    const candidateConfigs = [
      { ...config },
      config.description ? { ...config, description: undefined } : null,
      config.codec.startsWith('hev1') ? { ...config, codec: config.codec.replace('hev1', 'hvc1') } : null,
      config.codec.startsWith('hvc1') ? { ...config, codec: config.codec.replace('hvc1', 'hev1') } : null,
      (config.codec.includes('hev') || config.codec.includes('hvc')) ? { ...config, codec: 'hvc1.2.4.L153.B0', description: undefined } : null,
      (config.codec.includes('hev') || config.codec.includes('hvc')) ? { ...config, codec: 'hev1.2.4.L153.B0', description: undefined } : null,
      (config.codec.includes('hev') || config.codec.includes('hvc')) ? { ...config, codec: 'hvc1.1.6.L93.B0', description: undefined } : null
    ].filter(Boolean);

    let chosenConfig = null;
    for (const cand of candidateConfigs) {
      try {
        const check = await VideoDecoder.isConfigSupported(cand);
        if (check && check.supported) {
          chosenConfig = cand;
          console.log('[WebCodecsStreamer] Confirmed supported VideoDecoder config:', cand.codec);
          break;
        }
      } catch (e) {
        // Try next candidate
      }
    }

    if (!chosenConfig) {
      console.warn('[WebCodecsStreamer] No exact config reported supported, trying best match:', config.codec);
      chosenConfig = config;
    }

    this.videoDecoder = new VideoDecoder({
      output: (frame) => {
        this.videoFrameQueue.push(frame);
      },
      error: (e) => {
        console.error('[WebCodecsStreamer] VideoDecoder error:', e);
      }
    });

    this.videoDecoder.configure(chosenConfig);
    console.log('[WebCodecsStreamer] VideoDecoder configured successfully.');
  }

  play() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    if (this.onStateChange) this.onStateChange('playing');

    this.startDemuxLoop();
    this.startRenderLoop();
  }

  pause() {
    this.isPlaying = false;
    if (this.onStateChange) this.onStateChange('paused');
    if (this.renderLoopId) cancelAnimationFrame(this.renderLoopId);
  }

  stop() {
    this.pause();
    this.currentTime = 0;
    while (this.videoFrameQueue.length > 0) {
      const f = this.videoFrameQueue.shift();
      f.close();
    }
    if (this.videoDecoder && this.videoDecoder.state === 'configured') {
      try { this.videoDecoder.reset(); } catch (e) {}
    }
    if (this.audioDecoder && this.audioDecoder.state === 'configured') {
      try { this.audioDecoder.reset(); } catch (e) {}
    }
  }

  async startDemuxLoop() {
    if (this.demuxLoopRunning) return;
    this.demuxLoopRunning = true;

    try {
      while (this.isPlaying && this.fmt_ctx) {
        // Demux next packets using modern ff_read_frame_multi (replaces deprecated ff_read_multi)
        const [res, packets] = await this.libav.ff_read_frame_multi(
          this.fmt_ctx,
          this.demuxPkt,
          { limit: 32 * 1024 }
        );

        if (res === this.libav.AVERROR_EOF) break;

        // Process Video Packets
        if (this.videoStream && packets[this.videoStream.index]) {
          for (const pkt of packets[this.videoStream.index]) {
            if (this.videoDecoder && this.videoDecoder.state === 'configured') {
              try {
                const chunk = Bridge.packetToEncodedVideoChunk(pkt, this.videoStream);
                this.videoDecoder.decode(chunk);
              } catch (e) {
                console.warn('[WebCodecsStreamer] Video packet decode warning:', e);
              }
            }
          }
        }

        // Process Audio Packets
        if (this.audioStream && packets[this.audioStream.index]) {
          // Native WebCodecs AudioDecoder
          if (this.audioDecoder && this.audioDecoder.state === 'configured') {
            for (const pkt of packets[this.audioStream.index]) {
              try {
                const chunk = Bridge.packetToEncodedAudioChunk(pkt, this.audioStream);
                this.audioDecoder.decode(chunk);
              } catch (e) {}
            }
          }
          // Software WASM decoder fallback
          else if (this.audioCodecCtx) {
            try {
              const frames = await this.libav.ff_decode_multi(
                this.audioCodecCtx,
                this.audioPkt,
                this.audioFrame,
                packets[this.audioStream.index],
                false
              );

              for (const f of frames) {
                this.scheduleAudioFrame(f);
              }
            } catch (e) {
              console.warn('[WebCodecsStreamer] Audio decode warning:', e);
            }
          }
        }

        // Throttle demux loop if queue is full (buffer ~60 frames ahead)
        if (this.videoFrameQueue.length > 60) {
          await new Promise(r => setTimeout(r, 200));
        }
      }
    } catch (err) {
      console.error('[WebCodecsStreamer] Demux loop error:', err);
    } finally {
      this.demuxLoopRunning = false;
    }
  }

  scheduleAudioData(audioData) {
    if (!this.audioEngine || !this.audioEngine.ctx) {
      audioData.close();
      return;
    }

    try {
      const channels = audioData.numberOfChannels;
      const sampleRate = audioData.sampleRate;
      const numberOfFrames = audioData.numberOfFrames;

      const buffer = this.audioEngine.ctx.createBuffer(channels, numberOfFrames, sampleRate);
      for (let ch = 0; ch < channels; ch++) {
        const dest = new Float32Array(numberOfFrames);
        audioData.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
        buffer.copyToChannel(dest, ch);
      }

      const src = this.audioEngine.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.audioEngine.masterGain);
      if (this.audioEngine.splitter) {
        src.connect(this.audioEngine.splitter);
      }

      const now = this.audioEngine.ctx.currentTime;
      const when = Math.max(now, this.audioEngine.nextChunkTime || now);
      src.start(when);
      this.audioEngine.nextChunkTime = when + buffer.duration;
    } catch (err) {
      console.warn('[WebCodecsStreamer] AudioData scheduling warning:', err);
    } finally {
      audioData.close();
    }
  }

  scheduleAudioFrame(f) {
    if (!this.audioEngine || !this.audioEngine.ctx) return;
    const channels = f.channels || 2;
    const sampleRate = f.sample_rate || 48000;
    const nbSamples = f.nb_samples || 1024;

    try {
      const buffer = this.audioEngine.ctx.createBuffer(channels, nbSamples, sampleRate);
      if (Array.isArray(f.data)) {
        // Planar audio
        for (let ch = 0; ch < channels; ch++) {
          if (f.data[ch]) {
            const channelData = f.data[ch] instanceof Float32Array ? f.data[ch] : new Float32Array(f.data[ch]);
            buffer.copyToChannel(channelData, ch);
          }
        }
      } else if (f.data) {
        // Interleaved audio
        const flatData = f.data instanceof Float32Array ? f.data : new Float32Array(f.data);
        for (let ch = 0; ch < channels; ch++) {
          const chArray = new Float32Array(nbSamples);
          for (let i = 0; i < nbSamples; i++) {
            chArray[i] = flatData[i * channels + ch] || 0;
          }
          buffer.copyToChannel(chArray, ch);
        }
      }

      const src = this.audioEngine.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.audioEngine.masterGain);
      if (this.audioEngine.splitter) {
        src.connect(this.audioEngine.splitter);
      }

      const now = this.audioEngine.ctx.currentTime;
      const when = Math.max(now, this.audioEngine.nextChunkTime || now);
      src.start(when);
      this.audioEngine.nextChunkTime = when + buffer.duration;
    } catch (err) {
      console.warn('[WebCodecsStreamer] Audio scheduling warning:', err);
    }
  }

  startRenderLoop() {
    let lastTime = performance.now();
    let clock = this.currentTime || 0;

    const render = (now) => {
      if (!this.isPlaying) return;

      const dt = (now - lastTime) / 1000;
      lastTime = now;
      clock += dt;

      // Sync target timestamp with Web Audio or Wall clock
      let targetTime = clock;
      if (this.audioEngine && this.audioEngine.ctx && this.audioEngine.nextChunkTime) {
        targetTime = Math.max(0, this.audioEngine.ctx.currentTime);
      }

      while (this.videoFrameQueue.length > 0) {
        const frame = this.videoFrameQueue[0];
        const frameSec = (frame.timestamp || 0) / 1000000;

        // If frame is in the future (>35ms), wait for next RAF tick
        if (frameSec > targetTime + 0.035 && this.videoFrameQueue.length < 30) {
          break;
        }

        this.videoFrameQueue.shift();
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        this.currentTime = frameSec;
        frame.close();

        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }

        // Render one frame per RAF tick unless catching up
        if (frameSec >= targetTime - 0.05) {
          break;
        }
      }

      this.renderLoopId = requestAnimationFrame(render);
    };

    lastTime = performance.now();
    clock = this.currentTime || 0;
    this.renderLoopId = requestAnimationFrame(render);
  }
}
