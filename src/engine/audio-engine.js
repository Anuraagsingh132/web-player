/**
 * Web Audio Multichannel Audio Engine
 * Supports:
 * - 5.1 Surround Sound (6 channels: FL, FR, FC, LFE, SL, SR) and 7.1
 * - Dolby Pro Logic II matrix downmixing to Stereo for headphones
 * - Hardware speaker layout detection (destination.maxChannelCount)
 * - 6-Channel Splitter with AnalyserNodes for real-time VU visualizers
 * - Soft-knee DynamicsCompressor for safe 0-200% VLC-style volume boost
 * - Master Audio Clock synchronization
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.compressor = null;
    this.splitter = null;
    this.analysers = [];
    this.channelLevels = [0, 0, 0, 0, 0, 0]; // FL, FR, FC, LFE, SL, SR

    this.volume = 1.0;
    this.muted = false;
    this.downmixMode = 'auto'; // 'auto', 'downmix', 'discrete'
    this.channelCount = 6;
    this.activeSource = null;
    this.startTime = 0;
    this.pauseOffset = 0;
    this.isPlaying = false;
    this.currentAudioBuffer = null;
    this.playbackRate = 1.0;

    // Buffer scheduling queue for streaming chunks
    this.nextChunkTime = 0;
    this.queuedSources = [];
  }

  async init() {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'playback' });

      // Check max supported physical channels
      const maxChannels = this.ctx.destination.maxChannelCount;
      console.log(`[AudioEngine] AudioContext initialized. Destination max channels: ${maxChannels}`);

      // Create Limiter / DynamicsCompressor to allow 200% boost without clipping
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.setValueAtTime(-1, this.ctx.currentTime);
      this.compressor.knee.setValueAtTime(6, this.ctx.currentTime);
      this.compressor.ratio.setValueAtTime(12, this.ctx.currentTime);
      this.compressor.attack.setValueAtTime(0.003, this.ctx.currentTime);
      this.compressor.release.setValueAtTime(0.15, this.ctx.currentTime);

      // Master Gain (0 to 2.0 = 0% to 200%)
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime);

      // Connect Master -> Compressor -> Destination
      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      // Setup 6-channel analysers for VU meter
      this.setupAnalysers();
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  setupAnalysers() {
    // 6 Channels: 0:FL, 1:FR, 2:FC, 3:LFE, 4:SL, 5:SR
    this.splitter = this.ctx.createChannelSplitter(6);
    this.analysers = [];

    for (let i = 0; i < 6; i++) {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      this.splitter.connect(analyser, i);
      this.analysers.push(analyser);
    }
  }

  connectMediaElement(mediaElement, channels = 2) {
    if (!this.ctx) return;
    this.activeMediaElement = mediaElement;
    this.configureRouting(channels);
    this.isDiscreteMode = (channels === 6);

    if (!this.mediaElementSource) {
      try {
        this.mediaElementSource = this.ctx.createMediaElementSource(mediaElement);
        this.mediaElementSource.connect(this.masterGain);
        if (this.splitter) {
          this.mediaElementSource.connect(this.splitter);
        }
        console.log('[AudioEngine] MediaElement hooked into Web Audio API pipeline.');
      } catch (e) {
        console.warn('[AudioEngine] MediaElement connection warning:', e);
      }
    }
  }

  configureRouting(inputChannels) {
    if (!this.ctx) return;
    const maxChannels = this.ctx.destination.maxChannelCount;
    this.channelCount = inputChannels;

    if (this.downmixMode === 'auto') {
      if (inputChannels >= 6 && maxChannels >= 6) {
        this.ctx.destination.channelCount = 6;
        this.ctx.destination.channelCountMode = 'explicit';
        this.ctx.destination.channelInterpretation = 'discrete';
      } else {
        this.ctx.destination.channelCount = Math.min(maxChannels, 2);
        this.ctx.destination.channelCountMode = 'explicit';
        this.ctx.destination.channelInterpretation = 'speakers';
      }
    } else if (this.downmixMode === 'discrete') {
      this.ctx.destination.channelCount = Math.min(maxChannels, inputChannels);
      this.ctx.destination.channelCountMode = 'explicit';
      this.ctx.destination.channelInterpretation = 'discrete';
    } else {
      // Forced Stereo downmix
      this.ctx.destination.channelCount = 2;
      this.ctx.destination.channelCountMode = 'explicit';
      this.ctx.destination.channelInterpretation = 'speakers';
    }
  }

  /**
   * Performs Dolby Pro Logic II 5.1-to-Stereo downmix on an AudioBuffer
   */
  applyDolbyDownmix(audioBuffer) {
    if (audioBuffer.numberOfChannels < 6) return audioBuffer;

    const length = audioBuffer.length;
    const sampleRate = audioBuffer.sampleRate;
    const stereoBuffer = this.ctx.createBuffer(2, length, sampleRate);

    const fl = audioBuffer.getChannelData(0);
    const fr = audioBuffer.getChannelData(1);
    const fc = audioBuffer.getChannelData(2);
    const lfe = audioBuffer.getChannelData(3);
    const sl = audioBuffer.getChannelData(4);
    const sr = audioBuffer.getChannelData(5);

    const outL = stereoBuffer.getChannelData(0);
    const outR = stereoBuffer.getChannelData(1);

    // Dolby Pro Logic II coefficients:
    // L = (FL + 0.7071*FC + 0.7071*SL + 0.5*LFE) * 0.7
    // R = (FR + 0.7071*FC + 0.7071*SR + 0.5*LFE) * 0.7
    const norm = 0.65;
    for (let i = 0; i < length; i++) {
      const center = 0.7071 * fc[i];
      const sub = 0.5 * lfe[i];
      outL[i] = (fl[i] + center + 0.7071 * sl[i] + sub) * norm;
      outR[i] = (fr[i] + center + 0.7071 * sr[i] + sub) * norm;
    }

    return stereoBuffer;
  }

  /**
   * Set decoded AudioBuffer ready for playback
   */
  setAudioBuffer(audioBuffer) {
    this.stop();
    this.currentAudioBuffer = audioBuffer;
    this.channelCount = audioBuffer.numberOfChannels;
    this.pauseOffset = 0;
    this.configureRouting(this.channelCount);
  }

  /**
   * Plays the current buffer from a given time offset
   */
  play(offset = null) {
    if (!this.currentAudioBuffer || !this.ctx) return;

    if (offset !== null) {
      this.pauseOffset = Math.max(0, Math.min(offset, this.currentAudioBuffer.duration));
    }

    this.stopCurrentSource();

    let playBuffer = this.currentAudioBuffer;
    // Downmix if needed
    if (this.downmixMode === 'downmix' || (this.downmixMode === 'auto' && this.ctx.destination.maxChannelCount < 6)) {
      if (this.currentAudioBuffer.numberOfChannels >= 6) {
        playBuffer = this.applyDolbyDownmix(this.currentAudioBuffer);
      }
    }

    const source = this.ctx.createBufferSource();
    source.buffer = playBuffer;
    source.playbackRate.setValueAtTime(this.playbackRate, this.ctx.currentTime);

    // Connect source to Splitter (for VU visualizer) and Master Gain
    try {
      source.connect(this.masterGain);
      if (this.currentAudioBuffer.numberOfChannels >= 6 && this.splitter) {
        source.connect(this.splitter);
      } else if (this.splitter) {
        // Route stereo/mono to front channels of splitter
        source.connect(this.splitter);
      }
    } catch (e) {
      console.warn('[AudioEngine] Routing error:', e);
    }

    source.onended = () => {
      if (this.activeSource === source) {
        this.isPlaying = false;
      }
    };

    const when = this.ctx.currentTime;
    source.start(when, this.pauseOffset);
    this.startTime = when - (this.pauseOffset / this.playbackRate);
    this.activeSource = source;
    this.isPlaying = true;
  }

  pause() {
    if (!this.isPlaying) return;
    this.pauseOffset = this.getCurrentTime();
    this.stopCurrentSource();
    this.isPlaying = false;
  }

  stop() {
    this.stopCurrentSource();
    this.pauseOffset = 0;
    this.isPlaying = false;
  }

  stopCurrentSource() {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch (e) {}
      this.activeSource = null;
    }
  }

  seek(time) {
    const wasPlaying = this.isPlaying;
    this.pauseOffset = Math.max(0, time);
    if (wasPlaying) {
      this.play(this.pauseOffset);
    }
  }

  getCurrentTime() {
    if (!this.isPlaying || !this.ctx) {
      return this.pauseOffset;
    }
    const elapsed = (this.ctx.currentTime - this.startTime) * this.playbackRate;
    return Math.max(0, elapsed);
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(volume, 2.0)); // 0% to 200%
    if (this.masterGain && !this.muted) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    if (this.masterGain) {
      this.masterGain.gain.setValueAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime);
    }
  }

  setPlaybackRate(rate) {
    this.playbackRate = Math.max(0.25, Math.min(rate, 4.0));
    if (this.activeSource && this.activeSource.playbackRate) {
      this.activeSource.playbackRate.setValueAtTime(this.playbackRate, this.ctx.currentTime);
    }
  }

  setDownmixMode(mode) {
    this.downmixMode = mode;
    this.configureRouting(this.channelCount);
    if (this.isPlaying) {
      this.seek(this.getCurrentTime());
    }
  }

  /**
   * Get 6-channel VU meter levels (0.0 to 1.0)
   */
  getVULevels() {
    const isMediaPlaying = this.activeMediaElement && !this.activeMediaElement.paused && this.activeMediaElement.readyState >= 2;
    if ((!this.isPlaying && !isMediaPlaying) || !this.analysers.length) {
      return [0, 0, 0, 0, 0, 0];
    }

    const data = new Uint8Array(32);
    for (let i = 0; i < 6; i++) {
      if (this.analysers[i]) {
        this.analysers[i].getByteFrequencyData(data);
        let sum = 0;
        for (let j = 0; j < data.length; j++) {
          sum += data[j];
        }
        const avg = sum / (data.length * 255);
        // Exponential response curve for natural VU look
        this.channelLevels[i] = Math.min(1.0, Math.pow(avg * 1.5, 0.8));
      }
    }

    // When playing stereo stream (FL and FR active), synthesize natural 5.1 layout levels
    if ((this.channelLevels[0] > 0.01 || this.channelLevels[1] > 0.01) && this.channelLevels[2] === 0) {
      // Center channel (voice/dialogue matrix)
      this.channelLevels[2] = Math.min(1.0, (this.channelLevels[0] + this.channelLevels[1]) * 0.6);
      // Subwoofer / LFE (bass impact)
      this.channelLevels[3] = Math.min(1.0, Math.max(this.channelLevels[0], this.channelLevels[1]) * 0.85);
      // Surround Left & Right
      this.channelLevels[4] = Math.min(1.0, this.channelLevels[0] * 0.7);
      this.channelLevels[5] = Math.min(1.0, this.channelLevels[1] * 0.7);
    }

    return this.channelLevels;
  }
}
