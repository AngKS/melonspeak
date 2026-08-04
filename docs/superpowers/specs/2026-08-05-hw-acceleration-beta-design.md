# Hardware acceleration (beta): multithreaded WASM + WebGPU behind a toggle

**Date:** 2026-08-05
**Branch:** `worktree-hw-acceleration-beta`
**Goal:** opt-in synthesis speedup — multithreaded WASM and, where possible,
WebGPU — that can never make things worse than the shipped single-thread path.

## Safety model

Acceleration is **advisory at every layer**; each layer degrades silently:

1. The `accelBeta` setting (default **off**) merely *requests* acceleration.
2. WASM threads require SharedArrayBuffer, which requires cross-origin
   isolation. `wasmThreads()` checks `crossOriginIsolated` directly and
   returns 1 when absent (Firefox always; Chrome without the manifest keys).
3. WebGPU is attempted only when `navigator.gpu.requestAdapter()` actually
   returns an adapter (existing but adapter-less `navigator.gpu` is common in
   extension contexts), and every `InferenceSession.create` with
   `['webgpu','wasm']` is wrapped in a try/catch that retries plain WASM.
4. The engine worker is the only place any of this runs; a worker that dies
   is already handled by the existing error paths (skip chunk / 3-strike
   abort / model-missing reconciliation).

So the worst case of flipping the toggle on is: nothing gets faster.

## Cross-origin isolation (Chrome only)

`manifest.chrome.json` gains:

```json
"cross_origin_embedder_policy": { "value": "require-corp" },
"cross_origin_opener_policy": { "value": "same-origin" }
```

Verified empirically (smoke `--download --accel`):

- Extension pages report `crossOriginIsolated: true` and expose
  `SharedArrayBuffer`; the isolation reaches the offscreen document's
  dedicated worker (the "(4 threads)" load marker is computed *in* the
  worker).
- Hugging Face model downloads still work under `require-corp` — they are
  cors-mode fetches and HF serves `Access-Control-Allow-Origin`.
- Audio blob URLs, the keep-alive loop, downloads, uninstall, and the whole
  onboarding flow pass the full e2e suite with the keys in place.

ort 1.27 spawns its pthread workers as **module workers from
`import.meta.url`** (the self-hosted `chrome-extension://…/ort-wasm-simd-
threaded.jsep.mjs`), not blob URLs, so MV3's `script-src 'self'` CSP is
satisfied. The threaded jsep artifact was already the one we bundle for both
ort and transformers.js; no new binaries ship.

The Firefox manifest is untouched: Firefox has no COEP/COOP manifest keys, so
`crossOriginIsolated` stays false there and the toggle simply yields the
existing single-thread path (WebGPU may still engage if Firefox ever exposes
an adapter in extension workers — the runtime detection is browser-agnostic).

## Per-engine strategy

| Engine | Threads | WebGPU | Why |
|---|---|---|---|
| Kokoro (transformers.js) | ✓ `env.backends.onnx.wasm.numThreads` | ✗ | WebGPU needs non-q8 weights — a separate ~300 MB download replacing the installed q8 files, with known voice-quality issues. Not beta material. |
| Supertonic (raw ort) | ✓ `ort.env.wasm.numThreads` | ✓ `['webgpu','wasm']` per session, try/catch → WASM retry | Same onnx files either way; we own session creation. |
| Piper (piper-tts-web) | ✓ via property pin | ✗ | The library hardcodes session creation (no EP option). It also sets `numThreads = hardwareConcurrency` unconditionally — once isolation exists that would force max threads with the toggle OFF, so `piper.ts` pins the property (`Object.defineProperty` get/set) to the toggle's value before `TtsSession.create`. |

`wasmThreads(accel)` = `min(4, cores − 1)` — capped for diminishing returns on
small models, one core left for the UI/audio thread.

## Plumbing

- `Settings.accelBeta` (default false), written by UI pages via
  `updateSettings` like speed/voice; the background stays the only writer of
  download/onboarded flags.
- `speak`/`prepare` commands are enriched with `accel` by the background
  (the player context has no storage), and the worker `load` request carries
  it to `EngineModule.createEngine(onProgress, { accel })`.
- The player's engine cache is keyed by **(modelId, accel)** — `engineAccel`
  beside `engineId`, and the in-flight `engineLoad` dedup record carries the
  flag too, so a prepare/speak pair with different accel values can't share
  the wrong load.
- Thread count is fixed at the first `InferenceSession.create` in a worker,
  which is exactly why toggling must rebuild the worker: the background
  watches `storage.onChanged` for an `accelBeta` flip and sends
  `model-changed` (stop + dispose). A mid-read flip therefore stops the read
  — stated in the toggle's description.
- Engines surface the active mode in their load-progress details —
  "(4 threads)" / "(GPU)" — which the smoke test also uses as proof that the
  accelerated path really engaged in the worker.

## UI

One checkbox card, "Hardware acceleration **Beta**", in a new *Beta features*
section of the onboarding/setup page. Onboarding is the least
merge-contended surface (the side-panel spec explicitly leaves it unchanged)
and the natural home for setup-grade options; the ☰ sheet can absorb it later
if it graduates. The card uses its own `.beta-card` class — `.card` selectors
mean "model card" to both the download flow and the smoke harness.

## Testing

- `smoke.mjs --download --accel`: asserts extension pages are
  `crossOriginIsolated` with SAB, flips the toggle through the real UI,
  replays the sample, and requires a "(N threads)"/"(GPU)" load marker —
  failing if acceleration was requested but the engine silently stayed on
  the plain path. Restores the toggle afterwards.
- Verified per engine: Piper `… (4 threads)`, Kokoro `… (4 threads)`
  (transformers.js thread path), Supertonic `… (GPU)` — each synthesized and
  played to completion with the toggle on.
- The standard suites (unit, Chrome smoke, e2e download/remove, Firefox
  smoke, verify-read) all run with the manifest keys present, guarding the
  no-toggle regression surface.

## Research findings (web sweep, 2026-08-05)

Two research passes (WASM threads in MV3; WebGPU in extension contexts)
confirmed the design and added hardening. Key facts with sources:

- **COEP/COOP manifest keys** (Chrome 93+) apply extension-origin-wide — every
  `chrome-extension://` response carries the headers, which is what lets the
  dedicated worker (and ort's pthread workers) satisfy the COEP worker-script
  rule with zero per-file work. Known limits: isolation is not fully
  implemented for service/shared workers (we don't run inference there), and
  SharedArrayBuffer can't cross `runtime.sendMessage` (structured clone) —
  ort's internal pool never needs to. [Chrome manifest COEP docs;
  chromium-extensions threads]
- **ort ≥1.17 falls back to 1 thread silently** (console warning, added via
  microsoft/onnxruntime#19148) when isolation is missing — requesting threads
  is safe everywhere. **`env.wasm.proxy` must stay off**: the proxy worker is
  blob-URL-based and MV3 forbids blob workers (onnxruntime#14445); pthreads
  are module workers from `import.meta.url` and are fine. Never let a bundler
  rewrite the self-hosted `.mjs` (emscripten#22521).
- **Firefox**: bugzilla 1673477 (extension-page isolation) is open after 5+
  years, blocked on running every extension in its own process (1827085).
  The manifest keys are silently ignored. Single-thread is mandatory there,
  not just default — hence gating on `crossOriginIsolated`, never UA checks.
- **Kokoro WebGPU is correctly excluded**: kokoro.js README recommends fp32
  on webgpu — `model.onnx` is a *separate 326 MB file* from the installed
  92 MB q8; fp16/quantized dtypes produce broken audio on the WebGPU backend,
  and garbled output is also reported per-driver (AMD iGPUs, Android) even at
  fp32 (hexgrad/kokoro#98, #193). Not beta material, revisit upstream later.
- **piper-tts-web is hardcoded to WASM** (`inference.ts` passes no
  `executionProviders`); WebGPU there means forking session creation.
- **Supertonic's own web demo** ships the same fallback shape as ours:
  try webgpu, catch, recreate the session on wasm — EP lists alone don't
  give whole-session fallback, and unsupported ops fall back per-op to CPU
  with copy overhead (profile before assuming full-GPU).
- **Speedup expectations**: threads ≈1.5–2× for TTS (real Firefox-vs-Chromium
  extension TTS report), up to ~3.4× in ort's official small-CNN benchmark;
  Kokoro WebGPU reports range 2–10× but hardware-dependent. Threads can be a
  wash for very small per-call workloads — hence the beta framing.
- **Hardening adopted from the research**: `requestAdapter()` can hang (not
  reject) in GPU-crash-loop states → `webgpuAvailable()` races a 3 s timeout;
  a lost WebGPU device poisons its sessions permanently with `device.lost`
  as the only signal → the player now disposes the engine whenever a read
  aborts on synthesis failure, so the next attempt rebuilds fresh and
  re-runs feature detection.

## Rejected / future

- **Kokoro WebGPU** — dtype/download/quality issues above; revisit if a q8
  WebGPU path stabilizes upstream.
- **COEP `credentialless`** — `require-corp` already suffices for our only
  cross-origin traffic (cors HF downloads).
- **Graduating the toggle** — if the beta proves out, flip the default and
  keep the setting as an opt-out; the plumbing already supports it.
