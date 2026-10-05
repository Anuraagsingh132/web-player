/**
 * UI Controller for WebVLC Player
 * Connects DOM elements with PlayerCore, manages keyboard shortcuts,
 * visual VU meters, HUD inspector, OSD badges, and interactive seeking.
 */

export class PlayerUI {
  constructor(playerCore) {
    this.core = playerCore;
    this.vuAnimationId = null;
    this.osdTimer = null;
    this.showRemainingTime = false;

    this.bindDOMElements();
    this.attachEvents();
    this.startVUMeterLoop();
  }

  bindDOMElements() {
    this.dom = {
      // Containers
      stage: document.getElementById('playerStage'),
      videoWrapper: document.getElementById('videoWrapper'),
      video: document.getElementById('mainVideo'),
      canvas: document.getElementById('mainCanvas'),
      audioStandby: document.getElementById('audioStandby'),
      centerPlayBtn: document.getElementById('centerPlayBtn'),
      loadingOverlay: document.getElementById('loadingOverlay'),
      loadingText: document.getElementById('loadingText'),
      loadingProgressFill: document.getElementById('loadingProgressFill'),
      subtitleOverlay: document.getElementById('subtitleOverlay'),
      subtitlePill: document.getElementById('subtitlePill'),
      osdOverlay: document.getElementById('osdOverlay'),

      // Controls
      progressContainer: document.getElementById('progressContainer'),
      progressPlayed: document.getElementById('progressPlayed'),
      progressBuffered: document.getElementById('progressBuffered'),
      progressThumb: document.getElementById('progressThumb'),
      timeTooltip: document.getElementById('timeTooltip'),

      playPauseBtn: document.getElementById('playPauseBtn'),
      stopBtn: document.getElementById('stopBtn'),
      rewindBtn: document.getElementById('rewindBtn'),
      forwardBtn: document.getElementById('forwardBtn'),
      timeDisplay: document.getElementById('timeDisplay'),

      volumeBtn: document.getElementById('volumeBtn'),
      volumeSlider: document.getElementById('volumeSlider'),
      volumePercent: document.getElementById('volumePercent'),

      audioTrackSelect: document.getElementById('audioTrackSelect'),
      subtitleTrackSelect: document.getElementById('subtitleTrackSelect'),
      speedSelect: document.getElementById('speedSelect'),
      downmixSelect: document.getElementById('downmixSelect'),

      pipBtn: document.getElementById('pipBtn'),
      inspectorBtn: document.getElementById('inspectorBtn'),
      fullscreenBtn: document.getElementById('fullscreenBtn'),

      // VU Bars
      vuBars: [
        document.getElementById('vuBarFL'),
        document.getElementById('vuBarFR'),
        document.getElementById('vuBarFC'),
        document.getElementById('vuBarLFE'),
        document.getElementById('vuBarSL'),
        document.getElementById('vuBarSR'),
      ],

      // Inspector
      inspectorPanel: document.getElementById('inspectorPanel'),
      hudFilename: document.getElementById('hudFilename'),
      hudFormat: document.getElementById('hudFormat'),
      hudDuration: document.getElementById('hudDuration'),
      hudBitrate: document.getElementById('hudBitrate'),
      hudVideoCodec: document.getElementById('hudVideoCodec'),
      hudResolution: document.getElementById('hudResolution'),
      hudFps: document.getElementById('hudFps'),
      hudVideoEngine: document.getElementById('hudVideoEngine'),
      hudAudioCodec: document.getElementById('hudAudioCodec'),
      hudAudioChannels: document.getElementById('hudAudioChannels'),
      hudSampleRate: document.getElementById('hudSampleRate'),
      hudAudioEngine: document.getElementById('hudAudioEngine'),

      // Inputs
      dropzone: document.getElementById('dropzone'),
      fileInput: document.getElementById('fileInput'),
      subtitleFileInput: document.getElementById('subtitleFileInput'),
      urlInput: document.getElementById('urlInput'),
      streamUrlBtn: document.getElementById('streamUrlBtn'),

      // Presets
      presetChips: document.querySelectorAll('.preset-chip'),

      // Dynamic Badges
      badgeVideoEngine: document.getElementById('badgeVideoEngine'),
      badgeAudioEngine: document.getElementById('badgeAudioEngine'),
      badgeSurroundEngine: document.getElementById('badgeSurroundEngine')
    };
  }

  attachEvents() {
    // Player Core hooks
    this.core.onStateChange = (state) => this.handleStateChange(state);
    this.core.onTimeUpdate = (cur, dur) => this.handleTimeUpdate(cur, dur);
    this.core.onMetadataLoaded = (meta) => this.handleMetadataLoaded(meta);
    this.core.onProgress = (msg, pct) => this.handleProgress(msg, pct);
    this.core.onError = (err) => this.handleError(err);
    this.core.onWarning = (msg) => this.showToast(msg, 'warning');

    // Play/Pause / Stop
    this.dom.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
    this.dom.videoWrapper.addEventListener('click', (e) => {
      if (e.target !== this.dom.subtitleOverlay && !this.dom.subtitleOverlay.contains(e.target)) {
        this.togglePlayPause();
      }
    });
    this.dom.stopBtn.addEventListener('click', () => {
      this.core.stop();
      this.showOSD('⏹ Stopped');
    });

    // Skip
    this.dom.rewindBtn.addEventListener('click', () => this.seekDelta(-10));
    this.dom.forwardBtn.addEventListener('click', () => this.seekDelta(10));

    // Time display toggle
    this.dom.timeDisplay.addEventListener('click', () => {
      this.showRemainingTime = !this.showRemainingTime;
      this.handleTimeUpdate(this.core.currentTime, this.core.duration);
    });

    // Scrubber
    this.setupScrubberEvents();

    // Volume
    this.dom.volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this.core.setVolume(vol);
      this.updateVolumeUI(vol);
      this.showOSD(`🔊 Volume: ${Math.round(vol * 100)}%`);
    });

    this.dom.volumeBtn.addEventListener('click', () => {
      const muted = !this.core.muted;
      this.core.setMuted(muted);
      this.dom.volumeBtn.classList.toggle('active', muted);
      this.showOSD(muted ? '🔇 Muted' : `🔊 Volume: ${Math.round(this.core.volume * 100)}%`);
    });

    // Speed
    this.dom.speedSelect.addEventListener('change', (e) => {
      const rate = parseFloat(e.target.value);
      this.core.setPlaybackRate(rate);
      this.showOSD(`⚡ Speed: ${rate}x`);
    });

    // Downmix
    this.dom.downmixSelect.addEventListener('change', (e) => {
      this.core.setDownmixMode(e.target.value);
      this.showOSD(`🎧 Mode: ${e.target.options[e.target.selectedIndex].text}`);
    });

    // Audio Track
    this.dom.audioTrackSelect.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value, 10);
      if (this.core.metadata && this.core.metadata.audioTracks[idx]) {
        this.core.selectedAudioTrack = this.core.metadata.audioTracks[idx];
        this.core.switchAudioTrack(idx);
        const trk = this.core.metadata.audioTracks[idx];
        this.showOSD(`🎵 Audio: Track ${idx + 1} (${trk.codec.toUpperCase()} ${trk.lang || ''})`);
      }
    });

    // Subtitle Track
    this.dom.subtitleTrackSelect.addEventListener('change', async (e) => {
      if (e.target.value === 'upload') {
        this.dom.subtitleFileInput.click();
        e.target.value = '-1';
        return;
      }
      const idx = parseInt(e.target.value, 10);
      if (idx === -1) {
        this.core.subtitleEngine.setActiveTrack(-1);
        this.showOSD('💬 Subtitles: Off');
        return;
      }

      // Check if this track needs cues fetched from /api/subtitles (Issue 10)
      const track = this.core.subtitleEngine.tracks[idx];
      if (track && (!track.cues || track.cues.length === 0) && this.core.currentStreamUrl) {
        this.showOSD('💬 Extracting embedded subtitles...');
        try {
          const res = await fetch(`/api/subtitles?url=${encodeURIComponent(this.core.currentStreamUrl)}&track=${idx}`);
          if (res.ok) {
            const vtt = await res.text();
            track.cues = this.core.subtitleEngine.parseVTT(vtt);
            console.log(`[PlayerUI] Extracted ${track.cues.length} subtitle cues for track ${idx}`);
          }
        } catch (err) {
          console.warn('[PlayerUI] Subtitle extraction error:', err);
        }
      }

      this.core.subtitleEngine.setActiveTrack(idx);
      this.showOSD(`💬 Subtitles: Track ${idx + 1}`);
    });

    // External Subtitle File Loader
    this.dom.subtitleFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        const text = await file.text();
        const ext = file.name.split('.').pop().toLowerCase();
        this.core.subtitleEngine.addTrack(file.name, 'custom', text, ext);
        this.refreshSubtitleDropdown();
        this.showOSD(`💬 Loaded Subtitles: ${file.name}`);
      }
    });

    // Picture in Picture
    this.dom.pipBtn.addEventListener('click', async () => {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (this.dom.video.requestPictureInPicture) {
        await this.dom.video.requestPictureInPicture();
      }
    });

    // Inspector HUD
    this.dom.inspectorBtn.addEventListener('click', () => {
      this.dom.inspectorPanel.classList.toggle('visible');
      this.dom.inspectorBtn.classList.toggle('active');
    });

    // Fullscreen
    this.dom.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());

    // Drag and Drop
    this.setupDragAndDrop();

    // File Input
    this.dom.fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) this.loadFile(file);
    });

    // URL Stream
    this.dom.streamUrlBtn.addEventListener('click', () => this.loadUrl(this.dom.urlInput.value));
    this.dom.urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.loadUrl(this.dom.urlInput.value);
    });

    // Presets
    this.dom.presetChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const url = chip.dataset.sampleUrl;
        const name = chip.dataset.sampleName;
        if (url) this.loadUrl(url, name);
      });
    });

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => this.handleKeyboardShortcut(e));
  }

  setupScrubberEvents() {
    let isDragging = false;
    let pendingSeekTime = null;

    const updateVisual = (e) => {
      const rect = this.dom.progressContainer.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      pendingSeekTime = pos * this.core.duration;
      this.dom.progressPlayed.style.width = `${pos * 100}%`;
      this.dom.progressThumb.style.left = `${pos * 100}%`;
      return pos;
    };

    this.dom.progressContainer.addEventListener('mousedown', (e) => {
      isDragging = true;
      updateVisual(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) {
        updateVisual(e);
      }

      // Tooltip position
      const rect = this.dom.progressContainer.getBoundingClientRect();
      if (e.clientY >= rect.top - 20 && e.clientY <= rect.bottom + 20 &&
          e.clientX >= rect.left && e.clientX <= rect.right) {
        const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const hoverTime = pos * this.core.duration;
        this.dom.timeTooltip.style.left = `${pos * 100}%`;
        this.dom.timeTooltip.textContent = this.formatTime(hoverTime);
      }
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        if (pendingSeekTime !== null) {
          this.core.seek(pendingSeekTime);
          pendingSeekTime = null;
        }
      }
    });
  }

  setupDragAndDrop() {
    const dropzone = this.dom.dropzone;

    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        this.loadFile(files[0]);
      }
    });

    const browseBtn = document.getElementById('browseFileBtn');
    if (browseBtn) {
      browseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.dom.fileInput.click();
      });
    }
  }

  async loadFile(file) {
    this.showOSD(`📂 Loading: ${file.name}`);
    const arrayBuffer = await file.arrayBuffer();
    await this.core.loadMedia(new Uint8Array(arrayBuffer), file.name);
  }

  async loadUrl(url, customName = null) {
    if (!url || !url.trim()) return;
    url = url.trim();
    const name = customName || url.split('/').pop().split('?')[0] || 'stream_media';

    this.showOSD(`🌐 Streaming: ${name}`);
    this.dom.loadingOverlay.style.display = 'flex';

    try {
      await this.core.loadStreamUrl(url, name);
    } catch (err) {
      console.error('[PlayerUI] Streaming error:', err);
      this.handleError(err.message);
    }
  }

  togglePlayPause() {
    if (this.core.isPlaying) {
      this.core.pause();
      this.showOSD('⏸ Paused');
    } else {
      this.core.play();
      this.showOSD('▶ Playing');
    }
  }

  seekDelta(delta) {
    const nextTime = Math.max(0, Math.min(this.core.currentTime + delta, this.core.duration));
    this.core.seek(nextTime);
    this.showOSD(`${delta > 0 ? '⏩ +' : '⏪ '}${delta}s`);
  }

  updateVolumeUI(vol) {
    this.dom.volumePercent.textContent = `${Math.round(vol * 100)}%`;
    this.dom.volumePercent.classList.toggle('boosted', vol > 1.0);
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.dom.stage.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  handleKeyboardShortcut(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;

    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.togglePlayPause();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.seekDelta(-5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.seekDelta(5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        const vUp = Math.min(2.0, this.core.volume + 0.05);
        this.dom.volumeSlider.value = vUp;
        this.core.setVolume(vUp);
        this.updateVolumeUI(vUp);
        this.showOSD(`🔊 Volume: ${Math.round(vUp * 100)}%`);
        break;
      case 'ArrowDown':
        e.preventDefault();
        const vDown = Math.max(0, this.core.volume - 0.05);
        this.dom.volumeSlider.value = vDown;
        this.core.setVolume(vDown);
        this.updateVolumeUI(vDown);
        this.showOSD(`🔊 Volume: ${Math.round(vDown * 100)}%`);
        break;
      case 'KeyM':
        this.dom.volumeBtn.click();
        break;
      case 'KeyF':
        this.toggleFullscreen();
        break;
      case 'KeyI':
      case 'KeyC':
        this.dom.inspectorBtn.click();
        break;
    }
  }

  handleStateChange(state) {
    if (state === 'playing') {
      this.dom.playPauseBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
      this.dom.centerPlayBtn.classList.remove('visible');
    } else {
      this.dom.playPauseBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
      if (state === 'paused') this.dom.centerPlayBtn.classList.add('visible');
    }

    if (state === 'ready') {
      this.dom.loadingOverlay.style.display = 'none';
      this.dom.audioStandby.style.display = this.core.mode === 'audio-only' ? 'flex' : 'none';
    } else if (state === 'loading') {
      this.dom.loadingOverlay.style.display = 'flex';
    }
  }

  handleTimeUpdate(currentTime, duration) {
    const dur = duration || this.core.duration || 0;
    const progress = dur > 0 ? (currentTime / dur) * 100 : 0;

    this.dom.progressPlayed.style.width = `${progress}%`;
    this.dom.progressThumb.style.left = `${progress}%`;

    if (this.showRemainingTime && dur > 0) {
      const remaining = Math.max(0, dur - currentTime);
      this.dom.timeDisplay.textContent = `-${this.formatTime(remaining)} / ${this.formatTime(dur)}`;
    } else {
      this.dom.timeDisplay.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(dur)}`;
    }

    // Subtitle text update
    const subText = this.core.subtitleEngine.currentText;
    if (subText) {
      this.dom.subtitlePill.textContent = subText;
      this.dom.subtitleOverlay.style.display = 'block';
    } else {
      this.dom.subtitleOverlay.style.display = 'none';
    }
  }

  handleMetadataLoaded(meta) {
    // Populate HUD Inspector
    this.dom.hudFilename.textContent = meta.filename || 'media_file';
    this.dom.hudFormat.textContent = meta.format || 'Unknown';
    this.dom.hudDuration.textContent = meta.durationStr || '00:00:00';
    this.dom.hudBitrate.textContent = meta.bitrate || 'N/A';

    if (meta.videoTracks.length > 0) {
      const v = meta.videoTracks[0];
      this.dom.hudVideoCodec.textContent = v.codec || 'N/A';
      this.dom.hudResolution.textContent = v.resolution || 'N/A';
      this.dom.hudFps.textContent = `${v.fps} fps`;
      this.dom.hudVideoEngine.textContent = 'Hardware WebCodecs / GPU Canvas';
    } else {
      this.dom.hudVideoCodec.textContent = 'None (Audio Track Only)';
      this.dom.hudResolution.textContent = 'N/A';
      this.dom.hudFps.textContent = 'N/A';
      this.dom.hudVideoEngine.textContent = 'N/A';
    }

    if (meta.audioTracks.length > 0) {
      const a = meta.audioTracks[0];
      this.dom.hudAudioCodec.textContent = a.codec || 'N/A';
      this.dom.hudAudioChannels.textContent = a.channelLayout || `${a.channels} Channels`;
      this.dom.hudSampleRate.textContent = a.sampleRate || '48,000 Hz';
      this.dom.hudAudioEngine.textContent = this.core.currentStreamUrl ? 'Unified fMP4 AAC' : 'WASM Multichannel PCM';
    }

    // Dynamic Engine Badges
    if (this.dom.badgeVideoEngine) {
      const textEl = this.dom.badgeVideoEngine.querySelector('.badge-text') || this.dom.badgeVideoEngine;
      textEl.textContent = this.core.currentStreamUrl ? 'GPU Hardware HEVC' : 'WASM Remuxed GPU';
    }
    if (this.dom.badgeAudioEngine) {
      const textEl = this.dom.badgeAudioEngine.querySelector('.badge-text') || this.dom.badgeAudioEngine;
      textEl.textContent = this.core.currentStreamUrl ? 'Unified fMP4 AAC' : 'WASM Audio Decode';
    }
    if (this.dom.badgeSurroundEngine) {
      const textEl = this.dom.badgeSurroundEngine.querySelector('.badge-text') || this.dom.badgeSurroundEngine;
      textEl.textContent = this.core.downmixMode === 'discrete' ? 'Discrete 5.1 Surround' : 'Dolby Matrix Surround';
    }

    // Populate Audio Track Dropdown
    this.dom.audioTrackSelect.innerHTML = '';
    if (meta.audioTracks.length > 0) {
      meta.audioTracks.forEach((t, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `Track ${i + 1}: ${t.codec} (${t.channelLayout}, ${t.lang})`;
        this.dom.audioTrackSelect.appendChild(opt);
      });
    } else {
      this.dom.audioTrackSelect.innerHTML = '<option value="-1">No Audio Tracks</option>';
    }

    this.refreshSubtitleDropdown();
  }

  refreshSubtitleDropdown() {
    this.dom.subtitleTrackSelect.innerHTML = '<option value="-1">Subtitles: Off</option>';
    this.core.subtitleEngine.tracks.forEach((track, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${track.label} (${track.language})`;
      if (this.core.subtitleEngine.activeTrackIndex === i) {
        opt.selected = true;
      }
      this.dom.subtitleTrackSelect.appendChild(opt);
    });
    const uploadOpt = document.createElement('option');
    uploadOpt.value = 'upload';
    uploadOpt.textContent = '+ Load External .SRT/.VTT...';
    this.dom.subtitleTrackSelect.appendChild(uploadOpt);
  }

  handleProgress(msg, pct) {
    this.dom.loadingText.textContent = msg;
    this.dom.loadingProgressFill.style.width = `${pct}%`;
  }

  handleError(msg) {
    this.dom.loadingOverlay.style.display = 'none';
    this.showOSD(`⚠️ Error: ${msg}`);
    this.showToast(msg, 'error');
  }

  showToast(msg, type = 'info') {
    let toast = document.getElementById('toastNotification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toastNotification';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = `toast-notification show ${type}`;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 4500);
  }

  showOSD(text) {
    this.dom.osdOverlay.textContent = text;
    this.dom.osdOverlay.classList.add('show');
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(() => {
      this.dom.osdOverlay.classList.remove('show');
    }, 2000);
  }

  formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  startVUMeterLoop() {
    const loop = () => {
      if (this.core.isPlaying) {
        const levels = this.core.getVULevels();
        for (let i = 0; i < 6; i++) {
          if (this.dom.vuBars[i]) {
            const h = Math.round(levels[i] * 100);
            this.dom.vuBars[i].style.height = `${h}%`;
          }
        }
      } else {
        for (let i = 0; i < 6; i++) {
          if (this.dom.vuBars[i]) {
            this.dom.vuBars[i].style.height = '0%';
          }
        }
      }
      this.vuAnimationId = requestAnimationFrame(loop);
    };
    this.vuAnimationId = requestAnimationFrame(loop);
  }
}
