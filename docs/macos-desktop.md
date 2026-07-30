# Termdock for macOS

Termdock Desktop is a self-contained macOS application. The packaged app includes
Node.js, the Termdock server, `tmux`, `rg`, Git, and `mkcert`; users do not need
Homebrew, Node.js, npm, or a separately installed CLI to run it.

## Shared state and service behavior

- Desktop and CLI both use `~/.termdock`. Authentication, certificates, sessions,
  preferences, and caches are deliberately shared.
- The connection center can open an existing local CLI service, start a
  desktop-managed local service, or save and connect to any Termdock URL.
- After connecting, the window becomes the Termdock workspace itself.
  Desktop-only actions are embedded in Termdock Settings and the native macOS
  menu instead of living in a second application shell.
- A desktop-managed service exposes the same HTTP/WebSocket service as the CLI.
- If a local CLI service is already running, Desktop connects to it by default.
  Replacing it requires an explicit confirmation before Desktop sends `SIGTERM`.
- Closing the Desktop window does not silently stop a detached service.

Desktop-only connection bookmarks and UI state live in
`~/.termdock/desktop.json`. This file does not duplicate or isolate Termdock
server state.

## CLI installation and versions

On first launch the connection center detects `td`/`termdock` on the user's login
shell `PATH`, shows both installed and bundled versions, and offers a one-click
install. Installation creates `/usr/local/bin/td` and
`/usr/local/bin/termdock` symlinks to the launcher's copy inside the app bundle.
macOS requests administrator authorization when needed.

An existing CLI is never overwritten without the install action. The bundled
launcher always uses the app's private runtime and server, while sharing
`~/.termdock` with every other Termdock installation.

`td at [name]` uses the bundled tmux client and the same per-user default tmux
socket as the desktop service. A separately installed tmux normally sees the
same sessions too, but `td at` remains reliable if tmux client versions differ.

## macOS integration

- Native inset title bar and traffic lights share Termdock's chrome surface.
- `⌘,` opens Termdock Settings, including Desktop service, CLI, and data actions.
- `⌘T` creates a session, `⌘W` closes the active session, and `⌘⇧[` / `⌘⇧]`
  switch sessions.
- `⌘B` toggles sessions and `⌘⇧B` toggles the file sidebar.
- Files dropped from Finder onto a terminal are resolved through Electron's
  native file API and inserted as shell-quoted absolute paths.
- The last successful Termdock connection is reopened on the next launch.

## Building

Desktop packaging is supported on macOS arm64 with Node.js 22:

```bash
npm install
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run desktop:make
```

The build performs a real `node-pty` spawn probe and stages all runtime
dependencies under `.desktop-runtime`. Artifacts are written to `out/make`.

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
`update.electronjs.org/Jovines/termdock` feed. Termdock checks after launch and
periodically in the background; **Termdock → Check for Updates…** starts a
manual check. A downloaded update is installed only after the user accepts the
native restart prompt.

The ZIP filename includes `darwin-arm64`, which is required for the update
service to select the Apple Silicon asset. The repository must remain public
and releases must be published rather than left as drafts.

## Deferred macOS 27 issue

The macOS 27 beta local-network permission failure is recorded in
[macOS 27 local-network permission issue](macos-27-local-network.md). It is an
upstream system issue still awaiting retest on a newer macOS build.
