# Desktop Runtime updates

Termdock Desktop is split into two independently versioned layers:

- **Desktop Shell**: Electron, native menus and permissions, bundled Node,
  native production dependencies, and the bundled toolchain.
- **App Runtime**: the npm package's compiled `dist/server` and `dist/client`.

The settings panel reports and updates these layers separately:

- **CLI and service Runtime** checks the signed npm package and stages a compatible
  Runtime without replacing the desktop shell.
- **macOS desktop app** always checks the Squirrel.Mac GitHub release feed. A
  current Runtime never suppresses this desktop check. The user can start the
  check manually and, after download, explicitly restart to install it.

The shell always contains a complete fallback Runtime, so it remains usable
offline and can recover from a bad downloaded update.

Desktop-managed and globally installed services share the same user state under
`~/.termdock`, including authentication, settings, sessions, certificates, and
Agent plugin packages. Only the executable Runtime differs. A desktop-managed
service never invokes `npm install --global`; its update and restart are owned by
the Electron main process and use the bundled Node executable.

## Update flow

1. The packaged app checks `termdock/latest` on the npm registry.
2. It verifies the registry ECDSA package signature and the tarball SHA-512 SRI.
3. It validates every archive path before extraction.
4. It compares the Runtime protocol, minimum shell version, Node major, and
   production dependency hash with the bundled Runtime.
5. Compatible packages are staged under
   `~/.termdock/desktop-runtime/versions`, then activated by atomically replacing
   the `current` symlink.
6. The existing service is never killed by a background update. The new Runtime
   is used the next time Desktop starts its local service or the bundled `td`
   launcher runs. The launcher repeats the compatibility checks before using a
   downloaded CLI.
7. If a newly activated Runtime cannot start, Desktop switches back to the
   previous Runtime (or the bundled fallback) and retries once.

Set `TERMDOCK_RUNTIME_UPDATE=0` to disable registry checks.

## Deciding whether to rebuild macOS

Run:

```bash
git fetch --tags
npm run release:classify -- <last-desktop-tag>
```

Normal changes under `src/` publish through npm and do not require a new DMG.
A Desktop rebuild is required when `desktop/`, Forge/signing configuration,
the embedded toolchain preparation, Node major, or production dependencies
change. Unknown code paths are conservatively classified as Desktop changes.

When a Desktop rebuild is intentional, update
`desktop/runtime-compatibility.json` as needed. Raising
`minimumDesktopVersion`, `runtimeProtocolVersion`, `nodeMajor`, or changing the
production dependency hash causes older shells to reject the Runtime and use
their safe fallback until the Desktop app is upgraded.
