# Desktop and service updates

Termdock Desktop connects to independently installed Termdock services.
Each connected service owns its CLI installation and Runtime update lifecycle.
The CLI and service Runtime controls in Settings operate on that connected
service through its encrypted page transport.

The macOS application uses the Squirrel.Mac GitHub release feed. Its update
check is independent of the connected service version; a downloaded application
update is installed after the user chooses to restart and install.

Desktop no longer downloads or executes npm server runtimes, installs CLI
symlinks, stages production dependencies, or manages a local server through an
owner socket. Existing user data is left intact. See
[the upgrade notes](macos-desktop.md#upgrading-from-a-desktop-managed-service)
for installations that used the older bundled CLI.

Direct connections load the service's web frontend. A saved connection reachable
only through an entry service uses static frontend resources bundled with the
Desktop application; those resources update with the application.

## Deciding whether to rebuild macOS

Run:

```bash
git fetch --tags
npm run release:classify -- <last-desktop-tag>
```

Desktop source, Forge/signing configuration, and packaging workflow changes
require rebuilding the application. Standalone service changes publish through
npm. If an entry-service connection needs a newer bundled frontend, rebuild the
application with that frontend.

The npm runtime manifest remains available for standalone service client
snapshots and previously released Desktop versions.
