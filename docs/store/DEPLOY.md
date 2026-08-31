# Deploying MelonSpeak

End-to-end submission for both stores. Do the shared prerequisites once, then
follow whichever platform you are shipping.

Listing copy is written out in [chrome-listing.md](chrome-listing.md) and
[firefox-listing.md](firefox-listing.md); images are covered in
[assets.md](assets.md).

---

## 0. Pre-flight (both platforms)

Run from a clean checkout. Every one of these must pass before you build a
release artifact.

```sh
npm ci                                    # exact locked versions, not npm install
npm run typecheck                         # TypeScript, no emit
npm test                                  # unit tests + manifest assertions
npm run build
npm run smoke                             # boots in Chrome for Testing
npm run smoke:firefox                     # boots in a real Firefox
npm run smoke:e2e -- --model=piper        # real download → on-disk → synthesis → remove
npm run smoke:firefox:e2e -- --model=piper
```

The smoke runs need Chrome for Testing (branded Chrome ≥ 137 removed
`--load-extension`):

```sh
npx @puppeteer/browsers install chrome@stable --path .chrome-for-testing
```

Then set the version and build the artifacts:

```sh
# package.json is the single source of the version; the build stamps both
# manifests from it. Edit it, then:
npm run package
```

This writes three files into `dist/`:

| Artifact | Goes to |
|---|---|
| `melonspeak-chrome-<version>.zip` | Chrome Web Store |
| `melonspeak-firefox-<version>.zip` | addons.mozilla.org |
| `melonspeak-source-<version>.zip` | addons.mozilla.org **source code** step |

Also update `CHANGELOG.md` and commit and tag the release:

```sh
git add -A && git commit -m "Release 1.0.0"
git tag -a v1.0.0 -m "MelonSpeak 1.0.0"
git push origin main --tags
```

### Publish the privacy policy first

Both stores need a **publicly reachable** privacy policy URL, and both reject a
submission whose URL 404s. `PRIVACY.md` is written to serve as that page.

**Default (zero setup):** once the repo is public on GitHub, the file is already
served at

```
https://github.com/AngKS/melonspeak/blob/main/PRIVACY.md
```

That is the URL written into both listing files. It needs no configuration and
cannot 404 as long as the repo is public, which removes the most common
first-submission rejection.

**Optional upgrade — a cleaner URL via GitHub Pages:**

1. Repo **Settings → Pages → Source: Deploy from a branch**, branch `main`,
   folder `/ (root)`.
2. Wait for the Pages build to finish.
3. Confirm what it actually serves — Jekyll renders `PRIVACY.md` as
   `PRIVACY.html`, so the URL is usually
   `https://angks.github.io/melonspeak/PRIVACY`.
4. If you switch, update the URL in **both**
   [chrome-listing.md](chrome-listing.md) and
   [firefox-listing.md](firefox-listing.md) so they cannot drift apart.

Verify whichever URL you use, before submitting:

```sh
curl -sIL https://github.com/AngKS/melonspeak/blob/main/PRIVACY.md | grep -i '^HTTP'
# expect a final 200
```

---

## 1. Chrome Web Store

### 1.1 One-time account setup

1. Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   and sign in with the Google account that will own the listing. **This choice
   is permanent** — a listing cannot be moved between accounts later.
2. Pay the **one-time $5 USD** developer registration fee.
3. Complete the publisher profile: display name, contact email, and
   **verify that email**. An unverified contact email blocks publishing.

### 1.2 Create the item

1. **Add new item** → upload `dist/melonspeak-chrome-1.0.0.zip`.
2. Wait for the upload to validate. Manifest errors surface here, not at review.

### 1.3 Fill the listing

Work through the four tabs, pasting from
[chrome-listing.md](chrome-listing.md):

- **Store listing** — name, summary, detailed description, category
  (Accessibility), language, icon, screenshots, promo tile.
- **Privacy** — single purpose statement, a justification for **every** declared
  permission (`<all_urls>`, `activeTab`, `scripting`, `contextMenus`, `storage`,
  `unlimitedStorage`, `offscreen`, `sidePanel`), the remote-code answer
  (**"No, I am not using remote code"**), the data-usage checklist (**check
  nothing**), the three certification checkboxes, and the privacy policy URL.
- **Distribution** — Public, all regions, free, not designed for children.
- Paste the reviewer notes from the listing file into **Notes for reviewer**.

> A missing permission justification is the single most common rejection.
> `npm test` asserts every declared permission appears in the listing docs, but
> nothing can check that you pasted them into the form — do it deliberately.

### 1.4 Submit

**Submit for review.** Choose whether to publish automatically on approval or
hold for manual publishing.

Expect review to take anywhere from a few hours to a couple of weeks.
`<all_urls>` plus a large package means MelonSpeak will not be in the fast lane;
budget for the long end on a first submission.

### 1.5 Updating later

1. Bump `version` in `package.json` (it must strictly increase).
2. `npm run package`.
3. Dashboard → your item → **Package → Upload new package** → submit.

---

## 2. addons.mozilla.org

### 2.1 One-time account setup

1. Create a Mozilla account and sign in at
   [addons.mozilla.org/developers](https://addons.mozilla.org/developers/).
2. Complete the developer profile. There is **no fee**.

### 2.2 Submit the add-on

1. **Submit a New Add-on** → **On this site** (listed distribution — this is
   what puts it in the public directory and enables automatic updates).
2. Upload `dist/melonspeak-firefox-1.0.0.zip`.
3. The validator runs immediately. It will confirm the add-on is
   Manifest V3 and that `data_collection_permissions` is present.

### 2.3 Upload the source code — mandatory

AMO asks: *"Do you use any of the following in your add-on? Source code
generated by a compiler, minifier, or bundler."*

**Answer yes.** MelonSpeak's bundles are minified by esbuild.

1. Upload `dist/melonspeak-source-1.0.0.zip`.
2. Paste the build instructions from the **Source code submission** section of
   [firefox-listing.md](firefox-listing.md) into the instructions box.

Skipping this step gets the version rejected during review, not at upload. The
instructions must work on a clean machine — a reviewer will run them.

### 2.4 Fill the listing

From [firefox-listing.md](firefox-listing.md): name, summary, description
(AMO's limited HTML, **not** Markdown), Accessibility category, tags, icon,
screenshots with captions, homepage, support site and email, privacy policy
URL, MIT license, and the version release notes.

### 2.5 Submit

Listed add-ons are reviewed by a human. First submissions typically take a few
days. A large add-on with `<all_urls>` and a source-code requirement lands at
the slower end.

### 2.6 Updating later

1. Bump `version` in `package.json`.
2. `npm run package`.
3. Developer Hub → your add-on → **Upload New Version**, and upload **both** the
   add-on zip and a fresh source zip.

### 2.7 Self-distribution alternative

If you would rather not wait for review, **Submit → On your own** gets a signed
`.xpi` you can distribute yourself, usually within minutes. It is signed for
installation in release Firefox but does not appear in the directory and gets
no store-driven discovery.

---

## 3. Post-publication

- [ ] Install the published build from each store on a clean profile and read a
      real page end to end. A store-processed package is not always identical to
      the one you uploaded.
- [ ] Confirm the privacy policy URL still resolves from both listings.
- [ ] Watch the reviewer email for the first 72 hours — a rejection usually
      names one fixable field.
- [ ] Create a GitHub release for the tag and attach the three zips.
- [ ] Record both store URLs in `README.md`.

## 4. If a submission is rejected

| Symptom | Almost always |
|---|---|
| "Permission not justified" (Chrome) | A permission box left blank. Every entry in `chrome-listing.md` maps to a box; fill all eight. |
| "Requesting unnecessary permissions" | A permission declared but unused. `npm test` checks each one has a call site — run it and remove whatever it flags. |
| "Remotely hosted code" (Chrome) | Reviewer read the Hugging Face download as code loading. Point at the reviewer note: those files are ONNX weights and JSON, consumed by the bundled runtime. |
| "Source code required" (AMO) | The source zip was not uploaded, or the build instructions failed on a clean machine. Verify with `npm ci && npm run build` in a fresh clone. |
| "Data collection not declared" (AMO) | `data_collection_permissions` missing from the manifest. `npm test` catches this. |
| Version rejected as not increasing | `package.json` was not bumped before `npm run package`. |
