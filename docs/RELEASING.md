# Releasing

## Cutting a release

```bash
node scripts/set-version.mjs 0.2.0     # updates all four version files
                                       # (package.json, Cargo.toml, Cargo.lock,
                                       #  tauri.conf.json — the lock is the one
                                       #  everyone forgets)
git commit -am "Release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The tag triggers `.github/workflows/release.yml`, which runs the tests, builds a
**universal** macOS binary (one download for Apple Silicon *and* Intel), and
publishes a GitHub Release with the `.dmg`, a `.app.tar.gz` and `SHA256SUMS.txt`.

CI refuses to publish if the tag and the app version disagree, so a `v0.2.0`
release can never ship a binary that calls itself `0.1.0`.

To rehearse without publishing: **Actions → Release → Run workflow**. A manual
run always builds and uploads the artifacts to the run itself and publishes
nothing — only a tag creates a release.

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

For a technical audience this is the nicest install, and it costs nothing.
Once the tap exists (it does not yet), it will be:

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

## Self-update

The app checks quietly a few seconds after launch, and on demand from
**mad ▸ Check for Updates…**. If there is a newer release it says which version,
shows the notes, and on agreement downloads it with a progress readout, installs
it and relaunches. One click.

Updates are **signed with a minisign keypair** that is nothing to do with Apple —
it exists so the app will only install a bundle that came from you. The public
half is committed in `tauri.conf.json`; the private half is not, and must not be.

### One-time setup

A keypair has already been generated. The private key is at:

```
~/.config/mad-release/updater.key
```

Back it up somewhere safe — **if it is lost, existing installs can never be
updated again**, because they will only accept bundles signed by the key whose
public half they shipped with. Then add it as a repository secret
(**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the contents of `~/.config/mad-release/updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | empty — the key was generated without one |

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.config/mad-release/updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body ""
```

**This secret is required, not optional.** With a pubkey in the config the
bundler *fails* rather than producing an unsigned build, so the release workflow
checks for the key up front and stops in seconds with a pointer here, instead of
dying several minutes into a build with a cryptic message.

To generate a fresh keypair — only if you have to, since it orphans every
existing install:

```bash
npx tauri signer generate -w ~/.config/mad-release/updater.key
# then paste the .pub contents into src-tauri/tauri.conf.json > plugins.updater.pubkey
```

### How the app finds an update

The release publishes `latest.json` next to the binaries, and the app points at
`releases/latest/download/latest.json` — so "latest" always resolves to the newest
manifest with nothing extra to host. One universal bundle serves every Mac, but
the updater matches on the exact target triple, so the manifest lists
`darwin-universal`, `darwin-aarch64` and `darwin-x86_64` all pointing at it.

Self-update replaces the app in place, which means **an unsigned build stays
unsigned** — the user allowed it once at install and is not asked again.

## What is deliberately not here

**Windows and Linux builds.** The app is macOS-first: the window chrome assumes
`titleBarStyle: Overlay` with a traffic-light inset, and the menu is built with
macOS conventions. Both would work with effort; neither has been tried.
