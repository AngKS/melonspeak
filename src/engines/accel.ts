// Shared helpers for the beta hardware-acceleration path. Everything here is
// advisory: engines ask for threads/WebGPU and the runtime quietly degrades
// to the plain single-threaded WASM path when the platform can't deliver.

/** WASM thread count to request. Multithreading needs SharedArrayBuffer,
 *  which only exists under cross-origin isolation (COEP/COOP manifest keys —
 *  Chrome-only; Firefox has no equivalent for extensions), so this checks
 *  `crossOriginIsolated` directly: ort and transformers.js would clamp back
 *  to 1 with a console warning anyway, and honest numbers keep the UI's
 *  "(N threads)" label truthful. Capped at 4 (diminishing returns for small
 *  models) and leaves one core for the UI/audio thread. */
export function wasmThreads(accel: boolean): number {
  if (!accel || !globalThis.crossOriginIsolated) return 1;
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 2) : 2;
  return Math.min(4, Math.max(1, cores - 1));
}

/** True when a WebGPU adapter is actually obtainable (navigator.gpu existing
 *  is not enough — extension contexts can expose it and still return no
 *  adapter). Never throws, and never hangs: requestAdapter() has been seen
 *  stalling instead of rejecting in bad driver states (e.g. after Chrome's
 *  GPU-process crash-loop lockout), so it races a timeout. */
export async function webgpuAvailable(timeoutMs = 3000): Promise<boolean> {
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
    if (!gpu) return false;
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    return (await Promise.race([gpu.requestAdapter(), timeout])) !== null;
  } catch {
    return false;
  }
}
