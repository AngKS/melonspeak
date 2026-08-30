# Changelog

All notable changes to MelonSpeak are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-08-30

First public release, to the Chrome Web Store and addons.mozilla.org.

### Added

- **Read any page aloud** with neural text-to-speech running entirely on your
  device. After a one-time model download, nothing — page text, audio,
  telemetry — leaves your computer.
- **Three voice models**, switchable at any time: Kokoro-82M (~97 MB, 9 English
  voices, recommended), Supertonic (~264 MB, 44.1 kHz, 2 voices) and Piper
  (~63 MB, smallest).
- **Read selected text**, from the panel or the right-click "Speak content" menu.
- **Now Reading panel** — auto-scrolling transcript with a live audio
  visualizer, click any line to jump there. Chrome side panel, Firefox sidebar,
  or the action popup where neither API exists.
- **Tab awareness** — the panel badges itself when the page being read moves to
  the background, offers to follow when that tab navigates away, and says so
  when the tab is closed.
- Pitch-preserving speed control (0.5×–2×), pause, resume, stop, and spacebar
  play/pause.
- Sentence-streamed synthesis: speaking starts after the first chunk rather
  than after the whole article, with duration-based lookahead buffering.
- Models unload after 5 minutes idle; engine code is lazy-loaded per use.
- **Hardware acceleration (beta)**, off by default: multithreaded WASM and
  WebGPU where the platform supports them, with silent fallback to the plain
  WASM path.
- Packaging (`npm run package`) producing Chrome, Firefox and AMO source
  archives, plus store listing and deployment documentation under `docs/store/`.

### Security & privacy

- No analytics, telemetry, accounts or advertising. See [PRIVACY.md](PRIVACY.md).
- No remotely hosted code: the ONNX runtime and the espeak-ng phonemizer are
  bundled inside the extension package. The only network request is the voice
  model download you initiate.
- Firefox manifest declares `data_collection_permissions: { required: ["none"] }`.
- All transcript and page-derived text is rendered via `textContent`; the
  extension has no HTML injection sink for page content.
