import fs from 'fs';
import path from 'path';

// Helper to write 16-bit multi-channel WAV
function create51SurroundWav(filePath, durationSec = 12, sampleRate = 48000) {
  const numChannels = 6; // FL, FR, FC, LFE, BL, BR
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const totalSamples = sampleRate * durationSec;
  const dataSize = totalSamples * blockAlign;

  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  buffer.writeUInt16LE(1, 20); // AudioFormat = 1 (PCM)
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample

  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Frequencies for each channel:
  // 0: FL (Front Left) ~ 440 Hz (A4)
  // 1: FR (Front Right) ~ 554 Hz (C#5)
  // 2: FC (Front Center) ~ 659 Hz (E5)
  // 3: LFE (Low Frequency Effects) ~ 60 Hz (Sub bass)
  // 4: SL (Surround Left) ~ 880 Hz (A5)
  // 5: SR (Surround Right) ~ 1108 Hz (C#6)
  const freqs = [440, 554.37, 659.25, 60, 880, 1108.73];

  let offset = 44;
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    // Rotate channel activation every 2 seconds:
    // 0-2s: Front Left
    // 2-4s: Front Right
    // 4-6s: Center
    // 6-8s: LFE (Sub)
    // 8-10s: Surround Left
    // 10-12s: Surround Right
    const activeChan = Math.floor((t % 12) / 2);

    for (let ch = 0; ch < numChannels; ch++) {
      let amp = 0;
      if (ch === activeChan) {
        // Active channel gets clear tone with envelope
        const env = Math.min(1, Math.sin(Math.PI * ((t % 2) / 2)));
        amp = 0.7 * env * Math.sin(2 * Math.PI * freqs[ch] * t);
      } else {
        // Ambient background low whisper tone
        amp = 0.05 * Math.sin(2 * Math.PI * freqs[ch] * t);
      }
      const val = Math.max(-32768, Math.min(32767, Math.floor(amp * 32767)));
      buffer.writeInt16LE(val, offset);
      offset += 2;
    }
  }

  fs.writeFileSync(filePath, buffer);
  console.log(`Generated 5.1 Surround WAV: ${filePath} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
}

// Generate sample subtitles
function createSampleSubtitles(filePath) {
  const srtContent = `1
00:00:00,500 --> 00:00:02,000
WebVLC Player: Testing Front Left (FL) Channel 440Hz

2
00:00:02,000 --> 00:00:04,000
Testing Front Right (FR) Channel 554Hz

3
00:00:04,000 --> 00:00:06,000
Testing Center Dialog (FC) Channel 659Hz

4
00:00:06,000 --> 00:00:08,000
Testing Low Frequency Effects (LFE Subwoofer) 60Hz

5
00:00:08,000 --> 00:00:10,000
Testing Surround Left (SL) Channel 880Hz

6
00:00:10,000 --> 00:00:12,000
Testing Surround Right (SR) Channel 1108Hz - All 5.1 Channels Operational
`;
  fs.writeFileSync(filePath, srtContent.trim());
  console.log(`Generated Sample SRT: ${filePath}`);
}

const samplesDir = path.resolve('public/samples');
if (!fs.existsSync(samplesDir)) {
  fs.mkdirSync(samplesDir, { recursive: true });
}

create51SurroundWav(path.join(samplesDir, 'surround_5.1_test.wav'));
createSampleSubtitles(path.join(samplesDir, 'sample_subtitles.srt'));
