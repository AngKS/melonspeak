# addons.mozilla.org listing — MelonSpeak 1.0.0

Copy-paste source for the AMO submission form. Deployment steps live in
[DEPLOY.md](DEPLOY.md).

AMO differs from the Chrome Web Store in three ways that matter here:

1. **Data collection is declared in the manifest**, not in a web form —
   `browser_specific_settings.gecko.data_collection_permissions`. Since
   2025-11-03 a new submission without this key is rejected.
2. **Source code must be uploaded** whenever the submitted files are produced
   by a build step that obscures them. MelonSpeak's bundles are minified by
   esbuild, so this is mandatory.
3. Review is performed by a human against the source you provide, so the build
   instructions below must actually work on a clean machine.

---

## Add-on name

```
MelonSpeak — Offline Text to Speech
```

## Summary (250 char max)

```
Read any web page aloud with neural text-to-speech that runs entirely on your device. Download a voice once, then everything — the text, the synthesis, the audio — stays on your computer. No cloud, no account, no telemetry. Works fully offline.
```

(238 characters.)

## Categories

- Primary: **Accessibility**
- Secondary: **Other**

## Description

```
MelonSpeak reads web pages out loud using neural text-to-speech that runs
entirely inside Firefox, on your own device.

Most read-aloud add-ons send the page you are reading to a server to be
synthesized. MelonSpeak does not. You download a voice model once, and from
then on everything — the text, the synthesis, the audio — stays on your
computer. It works with your network connection switched off.

<b>How it works</b>

Click the MelonSpeak button to open the reading sidebar, then press "Read this
page". MelonSpeak extracts the article text, starts speaking within a couple of
seconds, and shows an auto-scrolling transcript with a live audio visualizer.
Click any line to jump straight to it.

To read only part of a page, highlight it and press "Read highlighted text", or
right-click the selection and choose "Speak content".

<b>Choose your voice</b>

Three voice models, switchable at any time from the sidebar's menu:

• Kokoro-82M (~97 MB, recommended) — the most natural voice for its size, with
  9 English voices in US and UK accents. Apache-2.0 licensed.
• Supertonic (~264 MB) — the fastest engine and the highest audio fidelity
  (44.1 kHz), with two voices. Weights are OpenRAIL-M licensed.
• Piper (~63 MB) — the smallest download, and a dependable voice if disk space
  is tight. MIT licensed.

You choose which models to install, and you can delete any of them from the
setup page at any time.

<b>Built for actual reading</b>

• Speaking starts after the first sentence is synthesized, not after the whole
  article — long pages begin reading in seconds.
• Pitch-preserving speed control from 0.5× to 2×.
• Spacebar plays and pauses. The transcript follows along and scrolls itself.
• The sidebar tells you when the page being read is in a background tab, offers
  to follow along when that tab navigates somewhere else, and says so plainly
  when the tab is closed.
• Models unload after five minutes idle.

<b>Privacy</b>

MelonSpeak has no account, no analytics, no telemetry and no advertising. It
never transmits the pages you read. The single network request it makes is
downloading a voice model from Hugging Face, and only when you press download.

<b>Open source</b>

MIT licensed, source at https://github.com/AngKS/melonspeak
```

> AMO's description field accepts a limited set of HTML tags (`<b>`, `<i>`,
> `<a>`, `<ul>`, `<li>`, `<blockquote>`, `<code>`, `<em>`, `<strong>`).
> Markdown is not rendered.

## Homepage / Support

- **Homepage:** `https://github.com/AngKS/melonspeak`
- **Support site:** `https://github.com/AngKS/melonspeak/issues`
- **Support email:** `angkahshin@gmail.com`

## Privacy policy

```
https://github.com/AngKS/melonspeak/blob/main/PRIVACY.md
```

## License

**MIT License** — select it from AMO's dropdown rather than pasting custom text.

## Tags

`text-to-speech`, `tts`, `accessibility`, `offline`, `reader`, `screen-reader`

---

## Data collection declaration

This is set in the **manifest**, already present in `src/manifest.firefox.json`:

```json
"browser_specific_settings": {
  "gecko": {
    "id": "melonspeak@melonspeak.app",
    "strict_min_version": "140.0",
    "data_collection_permissions": {
      "required": ["none"]
    }
  }
}
```

`"none"` is the correct and honest declaration: MelonSpeak transmits no data of
any kind. Model files are fetched *from* Hugging Face; nothing is sent *to*
anyone. `strict_min_version` is `140.0` because the
`data_collection_permissions` key requires Firefox 140 or later.

A regression test (`npm test`, "the Firefox manifest declares its data
collection") fails the build if this key is ever removed.

---

## Permission justifications

AMO shows these to reviewers and, for host permissions, to users at install
time.

| Permission | Justification |
|---|---|
| `<all_urls>` | Required to extract text from whatever page the user asks to have read aloud. Used only in response to a user action — pressing Read in the sidebar, or the "Speak content" context menu. The manifest declares no `content_scripts`, so nothing runs on any page until the user acts. Firefox's sidebar does not grant `activeTab` to buttons inside it, so a narrower permission cannot serve the sidebar's Read button. |
| `activeTab` | Acts on the tab MelonSpeak was invoked from, after the "Speak content" context menu is used. |
| `scripting` | Injects the text extractor into that tab on demand (`scripting.executeScript`). |
| `contextMenus` | Adds the single "Speak content" item, shown only when text is selected. |
| `storage` | Saves the user's model, voice and speed preferences locally, plus the id of the tab being read so the sidebar can report its state. Never transmitted. |
| `unlimitedStorage` | Voice models are 63–264 MB and must persist for offline synthesis; the default quota cannot hold them reliably. |

---

## Source code submission

**Required.** AMO must receive the original sources because the uploaded
bundles are minified by esbuild.

Upload `dist/melonspeak-source-1.0.0.zip` (produced by `npm run package`) in
the "Source code" step, and paste the following into the build-instructions
box:

```
BUILD ENVIRONMENT
  Node.js 20 or later (tested on Node 20 and 22)
  npm 10 or later
  Operating system: any (macOS, Linux and Windows all produce identical output)
  No compilers, native modules or network access are needed beyond `npm ci`.

BUILD STEPS
  1. unzip melonspeak-source-1.0.0.zip
  2. npm ci
  3. npm run build

  Step 3 writes dist/firefox/, which is byte-for-byte the contents of the
  submitted melonspeak-firefox-1.0.0.zip.

WHAT THE BUILD DOES  (scripts/build.mjs)
  - Bundles the TypeScript in src/ with esbuild 0.28.1 (minified, no source
    maps in a production build).
  - Copies the ONNX Runtime WebAssembly binaries out of
    node_modules/onnxruntime-web/dist and
    node_modules/@huggingface/transformers/dist into wasm/ort/ and wasm/tjs/.
  - Copies the espeak-ng phonemizer from
    node_modules/@diffusionstudio/piper-wasm/build into wasm/piper/.
  - Writes manifest.json from src/manifest.firefox.json, inserting the version
    from package.json. The source manifest deliberately carries no "version"
    field, so there is no second copy that can disagree with what was
    submitted; package.json is the single source of the version.
  scripts/icons.mjs regenerates the PNG icons from code; it uses only Node
  built-ins and needs no image library.

THIRD-PARTY CODE IN THE PACKAGE
  All third-party code is installed from npm at the exact versions pinned in
  package.json and package-lock.json. Nothing is vendored by hand and nothing
  is fetched from a URL at build time.

VERIFYING BEHAVIOUR
  npm run typecheck                 TypeScript, no emit
  npm test                          unit tests, including manifest assertions
  npm run smoke:firefox             boots the add-on in a real Firefox
  npm run smoke:firefox:e2e -- --model=piper
                                    downloads a model, asserts the bytes are on
                                    disk, synthesizes, then removes it

NETWORK BEHAVIOUR
  The add-on makes exactly one kind of request: downloading voice model files
  from huggingface.co, and only when the user presses download in setup. The
  files are ONNX weights and JSON config — data, not code. Everything needed to
  execute (the ONNX runtime, the phonemizer) is inside the package. The CSP is
  "script-src 'self' 'wasm-unsafe-eval'" and allows no remote origin.
```

---

## Version notes (release notes for this version)

```
First public release.

Read any web page aloud with neural text-to-speech running entirely on your
device — Kokoro-82M, Supertonic or Piper, downloaded once and then used fully
offline. Auto-scrolling transcript with a live visualizer, click-to-jump,
speed control from 0.5x to 2x, and read-a-selection from the sidebar or the
right-click menu.

No account, no analytics, no telemetry. The pages you read never leave your
computer.
```
