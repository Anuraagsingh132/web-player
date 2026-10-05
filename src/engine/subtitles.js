/**
 * Subtitles Engine for SRT and WebVTT parsing and synchronization
 */

export class SubtitleEngine {
  constructor() {
    this.tracks = []; // Array of { id, label, language, cues: [{ start, end, text }] }
    this.activeTrackIndex = -1; // -1 means subtitles Off
    this.currentText = '';
  }

  addTrack(label, language, content, format = 'srt') {
    const cues = format === 'vtt' ? this.parseVTT(content) : this.parseSRT(content);
    const track = {
      id: 'sub_' + (this.tracks.length + 1),
      label: label || `Track ${this.tracks.length + 1}`,
      language: language || 'und',
      cues
    };
    this.tracks.push(track);
    if (this.activeTrackIndex === -1 && cues.length > 0) {
      this.activeTrackIndex = this.tracks.length - 1; // Auto-select first loaded track
    }
    return track;
  }

  clear() {
    this.tracks = [];
    this.activeTrackIndex = -1;
    this.currentText = '';
  }

  setActiveTrack(index) {
    this.activeTrackIndex = index;
    if (index === -1) {
      this.currentText = '';
    }
  }

  getActiveTrack() {
    if (this.activeTrackIndex >= 0 && this.activeTrackIndex < this.tracks.length) {
      return this.tracks[this.activeTrackIndex];
    }
    return null;
  }

  timeStringToSeconds(timeStr) {
    if (!timeStr) return 0;
    // Normalize commas to periods (SRT uses commas, VTT uses periods)
    const normalized = timeStr.trim().replace(',', '.');
    const parts = normalized.split(':');
    if (parts.length === 3) {
      const hours = parseFloat(parts[0]);
      const minutes = parseFloat(parts[1]);
      const seconds = parseFloat(parts[2]);
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      const minutes = parseFloat(parts[0]);
      const seconds = parseFloat(parts[1]);
      return minutes * 60 + seconds;
    }
    return parseFloat(timeStr) || 0;
  }

  parseSRT(srtText) {
    const cues = [];
    const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = normalized.split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;

      let timeLineIndex = 1;
      // Handle cases where index number is missing or is the first line
      if (lines[0].includes('-->')) {
        timeLineIndex = 0;
      }

      const timeLine = lines[timeLineIndex];
      if (!timeLine || !timeLine.includes('-->')) continue;

      const [startStr, endStr] = timeLine.split('-->').map(s => s.trim().split(' ')[0]);
      const start = this.timeStringToSeconds(startStr);
      const end = this.timeStringToSeconds(endStr);

      const textLines = lines.slice(timeLineIndex + 1);
      const text = textLines.join('\n').trim();

      if (text && !isNaN(start) && !isNaN(end)) {
        cues.push({ start, end, text });
      }
    }

    return cues.sort((a, b) => a.start - b.start);
  }

  parseVTT(vttText) {
    // Strip WEBVTT header and comments, then parse same as SRT
    const cleanText = vttText.replace(/^WEBVTT[^\n]*\n/, '');
    return this.parseSRT(cleanText);
  }

  /**
   * Update current active subtitle text for the given timestamp
   */
  update(currentTime) {
    const track = this.getActiveTrack();
    if (!track || !track.cues.length) {
      this.currentText = '';
      return '';
    }

    const activeCues = track.cues.filter(c => currentTime >= c.start && currentTime <= c.end);
    this.currentText = activeCues.map(c => c.text).join('\n');
    return this.currentText;
  }
}
