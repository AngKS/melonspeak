# Store assets

Everything except the screenshots is generated from code.

```sh
npm run assets      # → docs/store/assets/
```

`scripts/store-assets.mjs` draws the tiles using the same `drawMelon()` the
shipped extension icon uses (`scripts/melon.mjs`) and the same brand colours as
the stylesheets, so the listing art and the installed icon cannot drift apart.
The wordmark is set in `scripts/glyphs.mjs`, a nine-glyph geometric sans drawn
as stroked paths — there is no font dependency. Output is deterministic:
re-running produces byte-identical files.

## Generated — ready to upload

| File | Size | Used for |
|---|---|---|
| `assets/store-icon-128.png` | 128×128 | **Required** by both stores. 96×96 of artwork with 16 px transparent padding, per Chrome's icon spec. |
| `assets/promo-tile-440x280.png` | 440×280 | Chrome small promo tile. **Effectively required** — listings without one rank below listings that have one. |
| `assets/promo-marquee-1400x560.png` | 1400×560 | Chrome marquee tile. Optional, but required to be *eligible* for marquee featuring. |

The 128×128 also serves as the AMO add-on icon; AMO renders it down to 64×64
and 32×32, and the mark stays readable at both.

Design: near-black `#101214` ground matching the Now Reading panel, the
watermelon mark, the `MelonSpeak` wordmark in cream, and the visualizer motif
as a melon→rind spectrum. Verified legible at 220×140, which is Chrome's
stated test for the small tile.

> `src/icons/icon128.png` — the icon *inside* the package — is a different
> file, drawn edge-to-edge because browser chrome supplies its own padding.
> Upload `assets/store-icon-128.png` to the stores, not that one.

## Still to do by hand: screenshots

| Store | Requirement |
|---|---|
| Chrome Web Store | 1–5 screenshots at 1280×800 (or 640×400), PNG or JPEG. **Required.** |
| addons.mozilla.org | At least 1; no fixed size, so 1280×800 keeps parity. Each takes an optional caption — use them. |

Both stores forbid mockups that misrepresent the product, so use real captures.
The smoke suites already take them at every step:

```sh
npm run build
npm run smoke                          # → dist/smoke/*.png
npm run smoke:e2e -- --model=kokoro    # → dist/smoke-e2e/*.png, with a model installed
```

Best raw material, in listing order:

| File | Shows | Suggested caption |
|---|---|---|
| `reader.png` | Now Reading panel mid-read: transcript, visualizer, transport | "Reads any page aloud, with a transcript that follows along." |
| `reader-cta.png` | Idle panel with the read-page / read-selection cards | "Read a whole page, or just what you highlighted." |
| `onboarding.png` (from `smoke-e2e`) | Model picker with sizes and licenses | "Pick a voice. Download once, then it works offline forever." |
| `reader-page-changed.png` | The ⤴ PAGE CHANGED badge and follow-offer toast | "Knows when the tab it is reading moves on — and offers to follow." |
| `reader-cta-finished.png` | Finished read with transcript retained | "Finished reads stay put, ready to replay." |

These capture at the panel's own size, not 1280×800. Compose each onto a
1280×800 canvas before uploading — the panel beside the page it was reading
reads best, and keeps the proportions honest in the store carousel.

## Pre-upload checklist

- [x] 128×128 store icon — `npm run assets`
- [x] 440×280 small promo tile — `npm run assets`
- [x] 1400×560 marquee tile — `npm run assets`
- [ ] 1–5 screenshots composed at 1280×800, showing the real UI
- [ ] Screenshots contain no personal data — check page content, profile name,
      bookmarks bar and open tab titles in every capture
- [ ] Every screenshot reflects 1.0.0 behaviour, not an older build
