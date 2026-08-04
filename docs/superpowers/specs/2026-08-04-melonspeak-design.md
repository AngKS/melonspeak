# MelonSpeak — Design

**Date:** 2026-08-04
**Goal:** A lightweight, stable, fully-offline TTS browser extension (Chrome + Firefox, Manifest V3) that reads web pages or highlighted text aloud using locally-downloaded neural TTS models. No data ever leaves the machine.

## Priorities (from user)

1. Accurate (faithful text extraction + natural speech)
2. Resource efficient (quantized models, lazy loading, nothing resident until used)
3. Easiest possible onboarding and daily use

## Models

| Model | Real name shown to user | Verified download | Notes |
|---|---|---|---|
| Kokoro | Kokoro-82M v1.0 (ONNX, 8-bit) | 92.4 MB + 9×0.52 MB voices ≈ 97 MB | Best quality/size; 24 kHz; Apache-2.0; via kokoro-js/transformers.js |
| Supertonic | Supertonic TTS (ONNX, 44.1 kHz) | 264 MB (4 ONNX + tokenizer + 2 voices) | Flow-matching, 8 denoise steps; weights OpenRAIL-M; upstream archived 2026-07 |
| Piper | Piper en_US-hfc_female (medium) | 63.2 MB | 22.05 kHz; MIT; espeak-ng WASM phonemizer bundled (18.7 MB in extension) |

**Voxtral note:** Voxtral (Mistral) is a speech *recognition* / audio-understanding model, not TTS, and is far too large for in-browser use. It is replaced by Piper as the third option. This is flagged to the user.

All inference runs in-browser via onnxruntime-web (WASM, single-thread default for stability). Model files are fetched once from HuggingFace during onboarding (with user consent + shown sizes), stored in the extension's Cache API storage (`unlimitedStorage`), and everything afterwards is 100% offline. No telemetry, no network calls at runtime.

## Architecture (one codebase, two manifests)

- **background.ts** — MV3 service worker (Chrome) / event page script (Firefox). Owns: install hook (opens onboarding), context menu ("Speak content" on selection), message routing, on-demand content-script injection.
- **player context** — where TTS inference + audio playback live, so playback survives popup close:
  - Chrome: offscreen document (`chrome.offscreen`, AUDIO_PLAYBACK justification)
  - Firefox: MV3 background page itself (event page has DOM + audio)
  - Same bundle (`player.ts`) in both.
- **content/extract.ts** — injected on demand (`scripting` + `activeTab`): Mozilla Readability on a cloned document for article text; `window.getSelection()` for highlighted text.
- **popup** — Read Page / Read Selection / model dropdown / play-pause-stop / progress.
- **onboarding page** — model checkboxes with real names + sizes, async downloads with progress (downloads run in the player context so closing the tab doesn't cancel), then a "try it" sample.
- **engines/** — `TTSEngine` interface + one adapter per model + registry (metadata, sizes, URLs) + downloader (streaming fetch → Cache API, progress events).

Pipeline: text → sentence chunker → engine synthesizes chunk-by-chunk → Web Audio queue (starts playing after first chunk; low latency). Pause/resume/stop via messages. Status broadcast to popup.

## UX

- Install → onboarding tab opens automatically: pick model(s) (or all), see sizes, hit Download, watch progress, done. Recommended default pre-selected (Kokoro).
- Popup: two big buttons (Read Page / Read Selection), model switcher, transport controls. Zero configuration required.
- Right-click on any selected text → "Speak content" → speaks immediately.
- If no model downloaded yet, popup deep-links to onboarding.

## Mid-build additions (user-requested)

- **Right-click context menu** — "Speak content" on any selection (`contextMenus`,
  `contexts: ["selection"]`), handled in background, spoken via the player.
- **Now Reading view** (`reader.html`) — Apple Music-style UX while TTS is active:
  auto-scrolling transcript where the current sentence is highlighted and
  neighbors fade/blur, plus a live audio visualizer. The player routes its audio
  through an `AnalyserNode` and streams 24 spectrum levels at ~15 fps over a
  `runtime.connect` Port, only while a view is connected and audio is speaking.
  Lyric highlighting is driven by the existing per-chunk status broadcasts;
  the full transcript is broadcast once per read. Opened from the popup.

## Error handling

- Download failures: per-file retry, resumable by re-running (cached files skipped).
- Engine load/synthesis failure: status message in popup, never a silent hang.
- No selection / no readable text: clear popup status message.

## Testing / verification

- `tsc --noEmit` type check + esbuild production build for both targets.
- Node unit test for the sentence chunker (accuracy-critical text handling).
- Manual load in Chrome (`dist/chrome`) and Firefox (`dist/firefox`).
