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
- Piper run: `… (4 threads)`, synthesis + playback verified end to end.
- The standard suites (unit, Chrome smoke, e2e download/remove, Firefox
  smoke, verify-read) all run with the manifest keys present, guarding the
  no-toggle regression surface.

## Rejected / future

- **Kokoro WebGPU** — dtype/download/quality issues above; revisit if a q8
  WebGPU path stabilizes upstream.
- **COEP `credentialless`** — `require-corp` already suffices for our only
  cross-origin traffic (cors HF downloads).
- **Graduating the toggle** — if the beta proves out, flip the default and
  keep the setting as an opt-out; the plumbing already supports it.
