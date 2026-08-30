# MelonSpeak Privacy Policy

**Last updated:** 30 August 2026
**Applies to:** MelonSpeak browser extension for Google Chrome and Mozilla Firefox, version 1.0.0 and later.

## The short version

MelonSpeak does not collect, transmit, store on a server, or sell any of your
data. There is no account, no analytics, no telemetry, no crash reporting, and
no advertising. The extension makes exactly one kind of network request, and
only when you ask it to: downloading a voice model file from Hugging Face.

## What MelonSpeak does with the pages you read

When you ask MelonSpeak to read a page or a selection, it extracts the readable
text from that page and converts it to speech using a neural model that runs
**inside your browser, on your own device**.

- The page text is held in memory for the duration of the reading session.
- The synthesized audio is generated locally and played locally.
- Neither the text nor the audio is ever sent over the network.
- Neither is written to any server, log, or file outside your browser profile.

When you stop a read, close the tab being read, or close the browser, the text
and audio are discarded.

## What is stored on your device

MelonSpeak stores the following locally, using ordinary browser storage. None
of it leaves your machine.

| What | Where | Why |
|---|---|---|
| Voice model files (63–264 MB per model) | Browser Cache API and OPFS | So synthesis works fully offline after the one-time download |
| Your preferences: selected model, voice, playback speed, onboarding state, hardware-acceleration toggle | `chrome.storage.local` | To remember your settings between sessions |
| The id of the tab currently being read | `chrome.storage.session` | So the reading panel can tell you when that tab is backgrounded, navigates away, or closes. Cleared when the browser closes. |

You can delete all of it at any time: remove individual models from the
MelonSpeak setup page ("Remove"), or uninstall the extension, which removes
everything MelonSpeak stored.

## The one network request MelonSpeak makes

To synthesize speech offline, MelonSpeak first needs a voice model. When **you**
choose a model and click download, the extension fetches that model's files
from Hugging Face (`huggingface.co`), the public repository that hosts them:

- Kokoro-82M — `onnx-community/Kokoro-82M-v1.0-ONNX`
- Supertonic — `Supertone/supertonic`
- Piper — `diffusionstudio/piper-voices`

This is a plain file download. It carries no identifier of you, no page
content, and nothing about your browsing. Like any HTTP request it necessarily
reveals your IP address and the file requested to the server that serves it;
that data is handled under
[Hugging Face's privacy policy](https://huggingface.co/privacy), not by
MelonSpeak. MelonSpeak makes no other network request of any kind — after the
download completes, the extension works with networking entirely disabled.

## Permissions, and why each is needed

| Permission | Why MelonSpeak needs it |
|---|---|
| `<all_urls>` (host permissions) | To read aloud a page on any site you choose. MelonSpeak injects its text extractor into the tab you point it at. It never runs on a page until you press Read or use the "Speak content" menu, it does not run in the background, and it does not observe your browsing. |
| `activeTab` | To act on the tab you invoked MelonSpeak from. |
| `scripting` | To inject the text extractor into that tab on demand. |
| `contextMenus` | To provide the right-click "Speak content" item for a selection. |
| `storage` | To save your model, voice and speed preferences on your device. |
| `unlimitedStorage` | Voice models are 63–264 MB, above the default quota. |
| `offscreen` (Chrome) | To run synthesis and play audio in a background document, so playback survives closing the panel. |
| `sidePanel` (Chrome) | To show the reading panel. |

## Children's privacy

MelonSpeak collects no data from anyone, including children under 13.

## Changes to this policy

Any change to this policy will be published in this document with an updated
"Last updated" date, and noted in
[CHANGELOG.md](https://github.com/AngKS/melonspeak/blob/main/CHANGELOG.md). As
MelonSpeak collects nothing, a change here can only ever narrow what it does.

## Contact

Questions about privacy: <angkahshin@gmail.com>, or open an issue at
<https://github.com/AngKS/melonspeak/issues>.
