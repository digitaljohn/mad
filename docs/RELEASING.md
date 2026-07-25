# Releasing

## Cutting a release

```bash
node scripts/set-version.mjs 0.2.0     # updates all three version files
git commit -am "Release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The tag triggers `.github/workflows/release.yml`, which runs the tests, builds a
**universal** macOS binary (one download for Apple Silicon *and* Intel), and
publishes a GitHub Release with the `.dmg`, a `.app.tar.gz` and `SHA256SUMS.txt`.

CI refuses to publish if the tag and the app version disagree, so a `v0.2.0`
release can never ship a binary that calls itself `0.1.0`.

To rehearse without publishing: **Actions → Release → Run workflow**, leaving
*dry run* ticked. It builds and uploads the artifacts to the run, and creates no
release.

## The signing question

This is the one decision worth making deliberately, because it costs money.

**Unsigned — free, works today.** The `.dmg` installs and the app runs, but macOS
shows *"Apple could not verify mad is free of malware"* on first launch and the
user has to go to **System Settings → Privacy & Security → Open Anyway**. Once
per install. Fine for a team who were told to expect it; a real deterrent for
strangers.

**Signed and notarized — $99/year.** Requires the
[Apple Developer Program](https://developer.apple.com/programs/). The app opens
with no warning at all, and Gatekeeper is satisfied.

The workflow already supports both. It signs when the credentials exist and
builds unsigned when they don't, with no change to the file. To turn signing on,
add these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | your *Developer ID Application* certificate exported as `.p12`, then base64: `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting it |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAM123456)` — from `security find-identity -v -p codesigning` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | an **app-specific password** from appleid.apple.com, not your account password |
| `APPLE_TEAM_ID` | the 10-character team ID |

The release job prints whether the build ended up signed, so you can confirm it
took effect rather than assuming.

## Homebrew

For a technical audience this is the nicest install, and it costs nothing:

```bash
brew install --cask digitaljohn/tap/mad
```

It needs a tap — a repository named `homebrew-tap` under your account. Create
`digitaljohn/homebrew-tap`, then copy [`homebrew/mad.rb`](../homebrew/mad.rb)
into it as `Casks/mad.rb`, filling in the version and the SHA256 from the
release's `SHA256SUMS.txt`.

Two caveats worth knowing before you commit to it:

- **Homebrew does not remove the Gatekeeper prompt for an unsigned app.** Users
  would still need `brew install --cask --no-quarantine …` to skip it, which is a
  worse instruction than "click Open Anyway". Homebrew becomes clearly the best
  option *after* signing, not before.
- The cask has to be updated per release. That can be automated later; while
  releases are occasional, editing two lines by hand is fine.

Submitting to the main `homebrew-cask` repository instead of your own tap has
notability requirements (roughly 30+ stars/forks/watchers), so a personal tap is
the right starting point.

## What is deliberately not here

**Auto-update.** Tauri has `tauri-plugin-updater`, which needs its own signing
keypair and a manifest hosted somewhere. It is worth adding once there are users
who will not otherwise notice a new version — not before.

**Windows and Linux builds.** The app is macOS-first: the window chrome assumes
`titleBarStyle: Overlay` with a traffic-light inset, and the menu is built with
macOS conventions. Both would work with effort; neither has been tried.
