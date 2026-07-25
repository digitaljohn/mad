# Homebrew cask for mad.
#
# This file is a template, not a working cask — Homebrew never reads it from
# here. Copy it into a tap repository (digitaljohn/homebrew-tap) as
# `Casks/mad.rb` and fill in the version and sha256 from the release's
# SHA256SUMS.txt. See docs/RELEASING.md.

cask "mad" do
  version "0.1.1"
  sha256 "ff85675df06c3588d3834761f2340d0fef2b5ababed076cf1c2cfddc49127fe8" # dmg, from SHA256SUMS.txt

  url "https://github.com/digitaljohn/mad/releases/download/v#{version}/mad_#{version}_universal.dmg",
      verified: "github.com/digitaljohn/mad/"
  name "mad"
  desc "Clean markdown editor for folders full of specs, notes and documentation"
  homepage "https://github.com/digitaljohn/mad"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :big_sur"

  # The app updates itself (Tauri updater). Without this, `brew outdated`
  # reports a self-updated install as stale and `brew upgrade` stomps it.
  auto_updates true

  app "mad.app"

  # Everything mad writes outside the app bundle. `zap` removes it on
  # `brew uninstall --zap`; a plain uninstall leaves your preferences alone.
  zap trash: [
    "~/Library/Application Support/com.john.mad",
    "~/Library/Caches/com.john.mad",
    "~/Library/Preferences/com.john.mad.plist",
    "~/Library/WebKit/com.john.mad",
    "~/Library/Saved Application State/com.john.mad.savedState",
  ]
end
