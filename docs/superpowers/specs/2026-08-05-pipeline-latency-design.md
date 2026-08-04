# Pipeline latency: fast first word, buffered long reads

**Date:** 2026-08-05
**Goal:** cut click-to-first-word latency, and keep long reads gapless by
synthesizing ahead in the background instead of a 2-chunk lookahead that
stalled on every slow chunk.

## Problem

The old pipeline serialized everything on the click-to-audio path:

1. extraction ran to completion, then
2. the offscreen player document was created (Chrome), then
3. the engine worker spawned and the model loaded (the dominant cost), then
4. the first chunk — full size, up to 150–300 chars ≈ 10–20 s of audio —
   synthesized before anything was audible.

During playback, synthesis only ran `LOOKAHEAD = 2` chunks ahead of the play
position and then idled. Spare synthesis capacity was discarded, so any chunk
that synthesized slower than the previous one played caused an audible stall.

## Design

Four changes, all inside the existing producer/consumer architecture:

### 1. Warm-up during extraction (`prepare` command)

`readTab` fires `deliverToPlayer({ type: 'prepare' })` before injecting the
extractor. The background enriches it with the selected model (like `speak`);
delivery creates the offscreen document, and the player starts loading the
engine — all concurrent with extraction.

- Engine loads are deduped through a module-level `engineLoad` record:
  the `speak` that follows joins the in-flight load instead of racing a
  second worker. The latest caller owns the progress line.
- A load for a model nobody wants anymore is abandoned: its engine is
  disposed on arrival (`abandonEngineLoad`).
- `prepare` never touches an active read (guarded on idle/error state) and
  never surfaces errors — `speak` re-attempts and owns error reporting,
  including the model-missing reconciliation.
- Interference is detected via the session counter alone: every command that
  could take over (speak/stop/model-changed) bumps it.

### 2. Small first chunks (`firstChunkMax`)

`chunkText(text, maxLen, firstChunkMax)` re-splits the opening chunk under an
80-char cap (`FIRST_CHUNK_CHARS`). First-word latency is gated by the first
synthesis, which scales with chunk length; the re-split also yields a run of
small opening chunks, so the buffer fills quickly at the start of the read.
Later chunks keep full size for prosody and throughput.

### 3. Duration-based background buffering

`LOOKAHEAD = 2` (chunks) became `BUFFER_AHEAD_SEC = 60` (seconds of audio,
scaled by playback speed — faster playback drains faster). The producer walks
the contiguous buffered run from the play position and synthesizes the first
missing chunk until the run meets the target, including while paused.

- Chunk durations are recorded at synthesis (`samples / sampleRate`).
- Memory stays bounded: ~60 s of 16-bit WAV is 3–5 MB depending on engine
  sample rate. Played chunks are freed on advance (after playing, not
  before, so a seek back to the current line replays from the buffer).
- Seeks free buffered audio behind the target — a forward jump must not
  strand a full buffer of never-played blobs — and un-mark freed chunks so
  they re-synthesize on demand.
- `set-speed` wakes the producer (`wakeSynthesis`) so the target re-scales.
- Engine `dispose()` now rejects in-flight synthesize promises: a terminated
  worker never answers, and the orphaned await would otherwise pin the dead
  session's buffer.

### 4. Perceived-latency trims

- The transcript is chunked and broadcast *before* the model load, so the
  reader shows the text immediately. If the load then fails, the transcript
  is cleared again (a read that never starts must not linger).
- The background→player ACK retry dropped from 200 ms to 50 ms polls (same
  ~6 s budget); it sits directly on the click-to-first-word path.

## Rejected

- **Second synthesis worker** for parallel chunk synthesis: doubles model
  memory (100–300 MB WASM heaps); conflicts with the resource-efficiency
  priority.
- **Web Audio scheduled gapless playback**: loses `preservesPitch` speed
  control on the audio element; the ~50 ms element swap is inaudible next to
  natural sentence pauses now that engine silence padding is trimmed.
- **Multithreaded WASM / WebGPU inference**: real throughput wins, but
  requires cross-origin isolation (SAB) or WebGPU in extension contexts —
  browser support is uneven. Possible future work.

## Verification

`npm run typecheck`, `npm test` (4 new chunker tests), `npm run smoke`,
`node scripts/smoke.mjs --download --model=piper` (real download + synthesis
+ playback), `node scripts/verify-read.mjs` (live-site read-page flow through
the new prepare path, seek, stop), `npm run smoke:firefox`.
