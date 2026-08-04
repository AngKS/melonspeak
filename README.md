# 🍉 MelonSpeak

A lightweight browser extension (Chrome + Firefox, Manifest V3) that reads any
web page aloud with neural text-to-speech running **entirely on your device**.
After the one-time model download, nothing — page content, audio, telemetry —
ever leaves your computer.

## Features

- **One panel, everything in it** — the toolbar button opens the reading panel
  (side panel on Chrome, `sidebar_action` on Firefox); there is no popup. Read
  page, read highlighted text, pause/stop, voice model, voice and speed all
  live there.
- **Read page** — extracts the readable article (Mozilla Readability) and speaks it.
- **Read highlighted text** — or right-click a selection → **Speak content**.
- **Now Reading view** — Apple Music-style auto-scrolling lyrics with a live
  audio visualizer; click any line to jump there. Opens automatically when a
  read starts, and badges itself **⤴ BACKGROUND** when you switch away from the
  page being read — click the header to go back. Closing that tab stops the
  read and says so.
- **Switch models/voices** — from the **☰** menu in the panel, at any time:

| Model | Real name | Download | Notes |
|---|---|---|---|
| Kokoro (recommended) | Kokoro-82M v1.0 (ONNX, 8-bit) | ~97 MB | Best quality/size; 9 voices; Apache-2.0 |
| Supertonic | Supertonic TTS (ONNX, 44.1 kHz) | ~264 MB | Fastest, highest sample rate; weights are OpenRAIL-M licensed; upstream repo being archived by Supertone (2026-07) |
| Piper | Piper en_US-hfc_female (medium, ONNX) | ~63 MB | Smallest; MIT |

> **Why no Voxtral?** Voxtral (Mistral) is a speech *recognition* model — it cannot
> synthesize speech, and the separate cloud-only "Voxtral TTS" is CC-BY-NC
> licensed. Piper stands in as the lightweight third option.

- Pitch-preserving speed control (0.5×–2×), pause/resume/stop.
- Models unload after 5 minutes idle; engines lazy-load per use.

## Build

```sh
npm install
npm run build        # production build → dist/chrome + dist/firefox
npm run build:dev    # unminified with sourcemaps
npm test             # chunker unit tests
npm run typecheck
npm run smoke        # boots the extension in Chrome for Testing, checks all surfaces
npm run smoke:e2e -- --model=piper   # + real download, synthesis and removal
npm run smoke:firefox                # the same surfaces in a real Firefox
npm run smoke:firefox:e2e -- --model=kokoro
```

The `--download` runs assert the model's bytes really are in the Cache API /
OPFS afterwards, not just that the UI said "Installed": a download that reports
success without persisting still plays fine (it silently re-downloads at load
time), so only a storage check catches it. The Firefox runs use
`/Applications/Firefox.app` — override with `FIREFOX_BIN`.

The smoke tests need the Chrome for Testing binary (branded Chrome ≥137 removed
`--load-extension`): `npx @puppeteer/browsers install chrome@stable --path .chrome-for-testing`

## Install (unpacked)

- **Chrome**: `chrome://extensions` → Developer mode → *Load unpacked* → `dist/chrome`
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → any file in `dist/firefox`

## Architecture

- `src/background.ts` — MV3 service worker (Chrome) / event page (Firefox):
  context menu, on-demand content-script injection, message routing.
- `src/player/` — the audio + inference host: offscreen document on Chrome,
  background page on Firefox. Sentence-streamed synthesis (starts speaking
  after the first chunk), producer/consumer with bounded lookahead.
- `src/engines/` — one adapter per model + registry + streaming downloader
  (HuggingFace → Cache API, resumable, progress events).
  `model-storage.ts` is the single source of truth for what is actually on
  disk (and for deleting it): storage-only, so UI pages can check without
  loading any engine code. Every "Installed" claim is verified against it.
- `src/content/extract.ts` — Readability extraction / selection capture.
- `src/reader/` — the reading panel, and the only interactive surface: it
  renders as Chrome's side panel, Firefox's sidebar, or (where neither API
  exists) the action popup itself. `read-actions.ts` owns the footer,
  `settings-menu.ts` the ☰ sheet.
- `src/onboarding/` — first run, and everything about downloading or removing
  models.

All inference runs on WASM (onnxruntime-web, single-threaded) with runtimes
bundled inside the extension — no CDN, no remote code.
