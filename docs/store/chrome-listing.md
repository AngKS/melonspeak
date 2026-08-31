# Chrome Web Store listing — MelonSpeak 1.0.0

Copy-paste source for the Chrome Web Store developer dashboard. Every field
below maps to a field in the submission form. Deployment steps live in
[DEPLOY.md](DEPLOY.md).

---

## Store listing tab

### Name (45 char max)

```
MelonSpeak — Offline Text to Speech
```

(35 characters.)

### Summary (132 char max)

```
Read any page aloud with neural text-to-speech that runs entirely on your device. No cloud, no account, no data collected.
```

(121 characters.)

### Category

`Accessibility` (primary). MelonSpeak is a reading aid; this is where users
looking for a read-aloud tool search first.

### Language

English (United States)

### Detailed description

```
MelonSpeak reads web pages out loud using neural text-to-speech that runs
entirely inside your browser, on your own device.

Most read-aloud extensions send the page you are reading to a server to be
synthesized. MelonSpeak does not. You download a voice model once, and from
then on everything — the text, the synthesis, the audio — stays on your
computer. It works with your network connection switched off.

■ HOW IT WORKS

Click the MelonSpeak button to open the reading panel, then press "Read this
page". MelonSpeak extracts the article text, starts speaking within a couple of
seconds, and shows an auto-scrolling transcript with a live audio visualizer.
Click any line to jump straight to it.

To read only part of a page, highlight it and press "Read highlighted text", or
right-click the selection and choose "Speak content".

■ CHOOSE YOUR VOICE

Three voice models, switchable at any time from the panel's menu:

• Kokoro-82M (~97 MB, recommended) — the most natural voice for its size, with
  9 English voices in US and UK accents. Apache-2.0 licensed.
• Supertonic (~264 MB) — the fastest engine and the highest audio fidelity
  (44.1 kHz), with two voices. Weights are OpenRAIL-M licensed.
• Piper (~63 MB) — the smallest download, and a dependable voice if disk space
  is tight. MIT licensed.

You choose which models to install, and you can delete any of them from the
setup page at any time.

■ BUILT FOR ACTUAL READING

• Speaking starts after the first sentence is synthesized, not after the whole
  article — long pages begin reading in seconds.
• Pitch-preserving speed control from 0.5× to 2×.
• Spacebar plays and pauses. The transcript follows along and scrolls itself.
• The panel tells you when the page being read is in a background tab, offers
  to follow along when that tab navigates somewhere else, and says so plainly
  when the tab is closed.
• Models unload after five minutes idle, so MelonSpeak costs nothing while you
  are not using it.

■ PRIVACY

MelonSpeak has no account, no analytics, no telemetry and no advertising. It
never transmits the pages you read. The single network request it makes is
downloading a voice model from Hugging Face, and only when you press download.

Full privacy policy: https://github.com/AngKS/melonspeak/blob/main/PRIVACY.md

■ OPEN SOURCE

MIT licensed, source at https://github.com/AngKS/melonspeak — including the
build scripts that produce exactly what is published here.
```

---

## Privacy tab

### Single purpose description

```
MelonSpeak converts the text of a web page — or a selection the user
highlights — into spoken audio, using a neural text-to-speech model that runs
locally in the browser. Reading web page text aloud is its only function.
```

### Permission justifications

Paste each into the matching box. Chrome asks for one per declared permission.

**`host_permissions` / `<all_urls>`**

```
MelonSpeak reads aloud whatever page the user asks it to, so it must be able to
extract text from any site the user visits. Host access is used for exactly one
thing: injecting the text extractor (src/content/extract.ts) into a tab, and
only in response to a user action — pressing "Read this page" in the panel,
using the "Speak content" context menu, or accepting the panel's offer to
follow a tab that navigated.

Narrower alternatives do not work here. activeTab is not granted when the user
clicks a button inside the side panel (the panel, not the page, has focus), and
it cannot cover the case where a tab being read navigates and the user asks
MelonSpeak to follow it to the new page.

MelonSpeak does not run content scripts automatically: the manifest declares no
content_scripts entry at all, and nothing is injected until the user acts. The
extracted text is used only to synthesize speech locally and is never
transmitted anywhere.
```

**`activeTab`**

```
Used to act on the tab the user invoked MelonSpeak from — specifically after
the "Speak content" context menu item is clicked on a selection, so the
selection can be read aloud.
```

**`scripting`**

```
Used to inject the text extractor into the tab the user asked to have read, on
demand via chrome.scripting.executeScript. This is how the page's readable text
is obtained. Nothing is injected until the user presses Read or uses the
context menu.
```

**`contextMenus`**

```
Creates the single right-click menu item "Speak content", shown only when text
is selected, so the user can read a highlighted passage aloud without opening
the panel.
```

**`storage`**

```
Stores the user's preferences on their own device: which voice model is
selected, the chosen voice, playback speed, whether onboarding is complete, and
the hardware-acceleration toggle. Also records which tab is currently being
read (in session storage) so the panel can report when that tab is
backgrounded, navigates, or closes. No preference data is transmitted.
```

**`unlimitedStorage`**

```
Voice models are large — 63 MB to 264 MB each — and must persist on disk for
MelonSpeak to synthesize speech offline. The default storage quota is not
sufficient to hold them reliably, and a model evicted mid-use would break
playback.
```

**`offscreen`**

```
Neural synthesis and audio playback run in an offscreen document. An MV3
service worker cannot play audio and is terminated while idle, which would cut
off playback whenever the user closed the panel or switched tabs. The offscreen
document is created on demand and closed again after five minutes idle.
```

**`sidePanel`**

```
The reading panel — the transcript, the visualizer and every playback control —
is rendered as Chrome's side panel, so it stays open beside the page being read
rather than closing the moment the user clicks the page.
```

### Remote code use

Select: **No, I am not using remote code.**

```
All executable code is contained in the extension package. The ONNX Runtime
WebAssembly binaries and the espeak-ng phonemizer are bundled at build time
(see scripts/build.mjs, which copies them from node_modules into wasm/) and
loaded from extension-relative URLs; the content security policy is
"script-src 'self' 'wasm-unsafe-eval'" and permits no remote origin.

MelonSpeak does download voice model files from Hugging Face when the user
chooses to install a model. These are ONNX neural network weights and JSON
configuration — data consumed by the bundled runtime, containing no
JavaScript and no executable logic.
```

### Data usage disclosures

Check **nothing** in the data collection checklist. MelonSpeak collects none of
the listed categories.

Then certify all three:

- ☑ I do not sell or transfer user data to third parties, apart from the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
https://github.com/AngKS/melonspeak/blob/main/PRIVACY.md
```

> Must be publicly reachable before you submit. See DEPLOY.md step 1.

---

## Distribution tab

- **Visibility:** Public
- **Distribution:** All regions
- **Pricing:** Free
- This item is **not** primarily designed for children.

---

## Reviewer notes (optional "Notes for reviewer" field)

```
MelonSpeak is fully open source: https://github.com/AngKS/melonspeak

To reproduce this exact package:
  npm ci
  npm run build      # emits dist/chrome
  npm run package    # emits dist/melonspeak-chrome-1.0.0.zip

Two points that may look unusual on review:

1. The extension downloads 63-264 MB from huggingface.co when the user opts to
   install a voice model. These are ONNX model weights (neural network
   parameters) and JSON config — data, not code. They are consumed by the
   ONNX Runtime WASM binary that ships inside this package.

2. The manifest sets cross_origin_embedder_policy / cross_origin_opener_policy.
   These enable cross-origin isolation so SharedArrayBuffer is available for
   the optional multithreaded-WASM acceleration mode, which is off by default.

The extension makes no other network request. It has no analytics, no server,
and no account system.
```
