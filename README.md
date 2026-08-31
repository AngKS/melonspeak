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
  page being read — click the header to go back. Follow a link in that tab and
  it badges **⤴ PAGE CHANGED** instead, with a 7-second offer to read the page
  it moved to. Closing that tab stops the read and says so.
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
npm test             # unit tests + distribution-manifest assertions
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

## Package for the stores

```sh
npm run package      # build + three release archives in dist/
```

| Artifact | Destination |
|---|---|
| `melonspeak-chrome-<version>.zip` | Chrome Web Store |
| `melonspeak-firefox-<version>.zip` | addons.mozilla.org |
| `melonspeak-source-<version>.zip` | addons.mozilla.org **source code** step — mandatory, because the bundles are minified |

`package.json` is the single source of the version: the build stamps it into
both manifests, so a release is one edit. Submission is documented step by step
in **[docs/store/DEPLOY.md](docs/store/DEPLOY.md)**, with the listing copy in
[chrome-listing.md](docs/store/chrome-listing.md) and
[firefox-listing.md](docs/store/firefox-listing.md).

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

All inference runs on WASM (onnxruntime-web) with runtimes bundled inside the
extension — no CDN, no remote code. The default path is single-threaded; the
opt-in acceleration beta requests multithreaded WASM and, for Supertonic,
WebGPU, falling back silently wherever the platform cannot deliver them.

## Privacy

No accounts, no analytics, no telemetry, no advertising. Page text and
synthesized audio never leave the device. The only network request MelonSpeak
makes is downloading a voice model from Hugging Face, and only when you ask for
one. Full policy: [PRIVACY.md](PRIVACY.md).

The Firefox manifest declares this formally as
`data_collection_permissions: { required: ["none"] }`, and `npm test` fails if
that declaration is ever removed.

## Model licenses

MelonSpeak's own code is [MIT](LICENSE). The voice models it downloads are
licensed separately by their publishers, and that license governs your use of
the model — not this repository's:

| Model | Weights license | Publisher |
|---|---|---|
| Kokoro-82M v1.0 | Apache-2.0 | [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |
| Supertonic | OpenRAIL-M (use restrictions apply) | [Supertone/supertonic](https://huggingface.co/Supertone/supertonic) |
| Piper en_US-hfc_female | MIT | [diffusionstudio/piper-voices](https://huggingface.co/diffusionstudio/piper-voices) |

Supertone are archiving the Supertonic repository upstream. The files still
resolve, and a future disappearance degrades to a message naming the cause
rather than a bare HTTP error — but it is the one model here whose availability
this project does not control.

## Security notes

- **No remotely hosted code.** The ONNX runtime and the espeak-ng phonemizer are
  bundled into the package at build time; the CSP is
  `script-src 'self' 'wasm-unsafe-eval'` and permits no remote origin. What is
  downloaded at runtime is ONNX weights and JSON — data consumed by the bundled
  runtime.
- **No HTML injection sink for page content.** Every transcript line and page
  title is written with `textContent`.
- `npm audit` reports a `sharp` advisory reached through
  `@huggingface/transformers`. `sharp` is a Node-only image library; the
  browser build aliases the Node built-ins away and never bundles it. Verify
  with `grep -r sharp dist/` — it is absent from the shipped artifact.
