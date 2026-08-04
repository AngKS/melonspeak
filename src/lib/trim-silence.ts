/**
 * Strip the silence every TTS engine pads its output with, leaving a short
 * pad so onsets and releases aren't clipped.
 *
 * Measured on Kokoro-82M: ~320 ms of leading and ~490 ms of trailing silence
 * per chunk. Played back-to-back that is ~810 ms of dead air at *every* chunk
 * boundary — the bulk of the unnatural pause between sentences, and entirely
 * independent of how fast the machine synthesizes.
 */

/** Absolute noise floor. Below this is inaudible regardless of the engine. */
const ABS_FLOOR = 0.005;
/** Also scale with the chunk's own peak, so quiet voices aren't over-trimmed. */
const PEAK_RATIO = 0.02;

export function trimSilence(samples: Float32Array, sampleRate: number, padMs = 60): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  const threshold = Math.max(ABS_FLOOR, peak * PEAK_RATIO);

  let start = 0;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start++;
  // Nothing audible at all: return empty rather than a chunk of pure silence.
  if (start === samples.length) return new Float32Array(0);
  let end = samples.length;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end--;

  // The pad can only give back silence that was actually there.
  const pad = Math.max(0, Math.round((padMs / 1000) * sampleRate));
  return samples.subarray(Math.max(0, start - pad), Math.min(samples.length, end + pad));
}
