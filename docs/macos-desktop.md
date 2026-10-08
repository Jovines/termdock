# Termdock for macOS

Termdock Desktop is a macOS client for independently running Termdock services.
It connects to local, LAN, and public service URLs without installing a CLI,
starting a server, taking over an existing process, or changing the shell environment.

## Service behavior

- Start local services separately with the standalone `termdock` CLI.
- The connection center detects an existing local service and can open it, or
  save and connect to another Termdock URL.
- Desktop-only bookmarks and UI preferences live in `~/.termdock/desktop.json`.
- Direct connections load the service's frontend. Saved connections reachable
  only through an entry service use the app's bundled static frontend.
- Closing or quitting Desktop leaves independently running services untouched.
- The app bundles static frontend resources for entry-service connections;
  Node.js, server dependencies, CLI launchers, and terminal tools are not bundled.

## Upgrading from a desktop-managed service

Older apps could install `td` / `termdock` symlinks into the app bundle. Before
replacing one of those apps, install the standalone CLI with `npm install -g termdock`
and verify that the commands resolve to that installation. If an old bundled
service is still running, stop it with the CLI and start the standalone service.
Your sessions, authentication, certificates, and preferences remain under
`~/.termdock`; upgrading the app does not delete them or stop the old process.

## macOS integration

- Native inset title bar and traffic lights share Termdock's chrome surface.
- `⌘,` opens Termdock Settings, including service switching, application updates, and data actions.
- `⌘T` creates a session, `⌘W` closes the active session, and `⌘⇧[` / `⌘⇧]`
  switch sessions.
- `⌘B` toggles sessions and `⌘⇧B` toggles the file sidebar.
- Files dropped from Finder onto a terminal are resolved through Electron's
  native file API and inserted as shell-quoted absolute paths.
- Pasting a macOS clipboard image uploads a PNG to the active service's `/tmp`
  directory and inserts the returned shell-quoted path. Local windows therefore
  receive a local path, while LAN service windows receive a path on that host.
- The last successful Termdock connection is reopened on the next launch.

## Building

Desktop packaging is supported on macOS arm64 with Node.js 22:

```bash
npm install
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run desktop:make
```

The build compiles the desktop shell and web frontend. Only the static frontend
is copied as an extra resource; no server runtime or toolchain is staged.
Artifacts are written to `out/make`.

By default Forge uses an ad-hoc signature for local development. For distribution,
provide a Developer ID Application identity:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Example (TEAMID)" \
  PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run desktop:make
```

Public distribution also requires Apple notarization. Forge performs it when
the Apple ID notarization environment variables documented below are present;
ordinary local builds remain unnotarized.

## GitHub releases and application updates

The `release-macos.yml` GitHub Actions workflow builds on an Apple Silicon
runner. A tag named `v<package-version>` produces a Developer ID signed and
notarized DMG plus an arm64 ZIP, uploads both as workflow artifacts, and attaches
them to the matching public GitHub Release.

Configure these repository secrets before publishing:

- `APPLE_CERTIFICATE_BASE64`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_KEYCHAIN_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Secret values must never be committed. The workflow contains only their names.

Users can download `Termdock.dmg` from the GitHub Releases page. Installed,
signed builds use Electron's native Squirrel.Mac updater and the public
GitHub Releases API through a loopback Squirrel feed. Termdock checks after launch and
periodically in the background; **Termdock → Check for Updates…** starts a
manual check. The in-app settings panel exposes the same desktop check beside
the independently versioned CLI/Runtime update, and offers **Restart and
install** after the download completes. A downloaded update is installed only
after the user accepts either restart action.

The ZIP filename includes `darwin-arm64`, which is required for the update
service to select the Apple Silicon asset. The repository must remain public
and releases must be published rather than left as drafts.

## Deferred macOS 27 issue

The macOS 27 beta local-network permission failure is recorded in
[macOS 27 local-network permission issue](macos-27-local-network.md). It is an
upstream system issue still awaiting retest on a newer macOS build.
