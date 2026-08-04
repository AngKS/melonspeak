/** Encode mono float samples as a 16-bit PCM WAV blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * One second of near-silent (-60 dB) noise, looped to keep the offscreen
 * document alive: Chrome closes AUDIO_PLAYBACK offscreen documents 30s after
 * audio stops, which would kill long model loads/downloads and paused reads.
 */
export function silentWav(sampleRate = 8000): Blob {
  const samples = new Float32Array(sampleRate);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (((i * 2654435761) % 1000) / 1000 - 0.5) * 0.002;
  }
  return encodeWav(samples, sampleRate);
}

/** Decode a mono/multi-channel PCM16 or float32 WAV (channels averaged). */
export function decodeWav(buf: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(buf);
  const tag = (o: number) =>
    String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let offset = 12;
  let format = 0;
  let channels = 1;
  let sampleRate = 0;
  let bits = 0;
  let samples: Float32Array | null = null;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      const bytesPer = bits / 8;
      const frames = Math.floor(size / (bytesPer * channels));
      samples = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const o = body + (f * channels + c) * bytesPer;
          sum +=
            format === 3 && bits === 32
              ? view.getFloat32(o, true)
              : view.getInt16(o, true) / 0x8000;
        }
        samples[f] = sum / channels;
      }
    }
    offset = body + size + (size & 1);
  }
  if (!samples || !sampleRate || (format !== 1 && format !== 3)) {
    throw new Error('Unsupported WAV format');
  }
  return { samples, sampleRate };
}
