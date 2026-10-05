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
      const vConfig = Bridge.videoStreamToConfig(this.videoStream);
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
      await this.audioEngine.init();
      // Setup audio decoder (WASM software decoder for AC-3/E-AC-3)
      const [, c, p, f] = await this.libav.ff_init_decoder(this.audioStream.codec_id, this.audioStream.codecpar);
      this.audioCodecCtx = c;
      this.audioPkt = p;
      this.audioFrame = f;

      this.metadata.audioTracks.push({
        codec: 'E-AC-3 / Dolby Digital Plus (Atmos)',
        channels: this.audioStream.channels || 6,
        channelLayout: '5.1 Surround',
        sampleRate: `${this.audioStream.sample_rate || 48000} Hz`
      });
    }

    if (this.onMetadataLoaded) this.onMetadataLoaded(this.metadata);
    if (this.onStateChange) this.onStateChange('ready');
  }

  async initVideoDecoder(config) {
    const isSupported = await VideoDecoder.isConfigSupported(config);
    console.log('[WebCodecsStreamer] VideoDecoder support check:', isSupported);

    this.videoDecoder = new VideoDecoder({
      output: (frame) => {
        this.videoFrameQueue.push(frame);
      },
      error: (e) => {
        console.error('[WebCodecsStreamer] VideoDecoder error:', e);
      }
    });

    this.videoDecoder.configure(config);
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
  }

  async startDemuxLoop() {
    if (this.demuxLoopRunning) return;
    this.demuxLoopRunning = true;

    try {
      while (this.isPlaying && this.fmt_ctx) {
        // Demux next packets
        const [res, packets] = await this.libav.ff_read_multi(
          this.fmt_ctx,
          this.demuxPkt,
          null,
          { limit: 32 * 1024 }
        );

        if (res === this.libav.AVERROR_EOF) break;

        // Process Video Packets
        if (this.videoStream && packets[this.videoStream.index]) {
          for (const pkt of packets[this.videoStream.index]) {
            if (this.videoDecoder && this.videoDecoder.state === 'configured') {
              const chunk = Bridge.packetToEncodedVideoChunk(pkt, this.videoStream);
              this.videoDecoder.decode(chunk);
            }
          }
        }

        // Process Audio Packets
        if (this.audioStream && packets[this.audioStream.index] && this.audioCodecCtx) {
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
        }

        // Throttle demux loop if queue is full (buffer 3 seconds ahead)
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

  scheduleAudioFrame(f) {
    if (!this.audioEngine.ctx) return;
    const channels = f.channels || 6;
    const sampleRate = f.sample_rate || 48000;
    const nbSamples = f.nb_samples || 1024;

    const buffer = this.audioEngine.ctx.createBuffer(channels, nbSamples, sampleRate);
    for (let ch = 0; ch < channels; ch++) {
      if (f.data[ch]) {
        buffer.copyToChannel(f.data[ch], ch);
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
  }

  startRenderLoop() {
    const render = () => {
      if (!this.isPlaying) return;

      if (this.videoFrameQueue.length > 0) {
        const frame = this.videoFrameQueue.shift();
        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
        this.currentTime = frame.timestamp / 1000000;
        frame.close();

        if (this.onTimeUpdate) {
          this.onTimeUpdate(this.currentTime, this.duration);
        }
      }

      this.renderLoopId = requestAnimationFrame(render);
    };

    this.renderLoopId = requestAnimationFrame(render);
  }
}
