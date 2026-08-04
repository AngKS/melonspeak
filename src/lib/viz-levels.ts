// Maps analyser frequency bins onto visualizer bars.
//
// The bars cover 60 Hz–10 kHz on a log scale rather than the analyser's full
// linear 0–Nyquist range. The AudioContext runs at the device rate (usually
// 48 kHz, Nyquist 24 kHz) but TTS audio is band-limited to its own Nyquist
// (11–12 kHz for Piper/Kokoro), so a linear map parks the right half of the
// bars on empty bins forever; log spacing also matches how speech energy is
// actually distributed, instead of cramming it into the leftmost bars.

const VIZ_MIN_HZ = 60;
const VIZ_MAX_HZ = 10_000;

/** Fold byte frequency data (0–255 per bin) into `barCount` levels in 0..1. */
export function binLevels(
  bins: Uint8Array,
  contextSampleRate: number,
  barCount: number,
): number[] {
  const hzPerBin = contextSampleRate / 2 / bins.length;
  const ratio = VIZ_MAX_HZ / VIZ_MIN_HZ;
  const levels: number[] = new Array(barCount);
  for (let b = 0; b < barCount; b++) {
    const f0 = VIZ_MIN_HZ * ratio ** (b / barCount);
    const f1 = VIZ_MIN_HZ * ratio ** ((b + 1) / barCount);
    const start = Math.min(bins.length - 1, Math.floor(f0 / hzPerBin));
    const end = Math.min(bins.length, Math.max(start + 1, Math.ceil(f1 / hzPerBin)));
    let sum = 0;
    for (let i = start; i < end; i++) sum += bins[i];
    levels[b] = Math.min(1, sum / (end - start) / 255);
  }
  return levels;
}
