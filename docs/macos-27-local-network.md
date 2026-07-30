# macOS 27 local-network permission issue

Status: deferred pending a macOS update or an Apple fix.

## Symptom

On macOS 27 beta, a signed Termdock desktop build cannot open another Termdock
service through its private-network IP address:

- the service is reachable from Terminal with `curl`;
- the signed app receives `net::ERR_ADDRESS_UNREACHABLE`;
- macOS does not show its native Local Network permission prompt;
- Termdock does not appear under **System Settings → Privacy & Security → Local
  Network**.

This is distinct from a Termdock TLS, routing, or service availability failure.
Do not treat a successful Terminal, SSH, ping, or curl check as proof that the
signed GUI app has local-network access.

## Environment reproduced

- macOS 27 beta, build `26A5368g`
- Apple Silicon
- Electron 43
- Developer ID signed Termdock 1.4.34
- direct HTTPS connection to a private IPv4 Termdock service

Machine names, user names, private IP addresses, credentials, API tokens, and
certificate material are intentionally omitted from this document.

## Work completed

The application-side requirements have been checked:

- the main app and all Electron Helper apps contain
  `NSLocalNetworkUsageDescription`;
- the main app and Helpers allow local networking through ATS;
- the app, Electron Framework, Helpers, dynamic libraries, embedded Node, and
  bundled toolchain share one Developer ID Team ID;
- `codesign --verify --deep --strict` succeeds;
- the application is not using App Sandbox;
- the connection attempt comes from the installed, signed
  `/Applications/Termdock.app`;
- rebooting macOS does not restore the missing prompt;
- replacing the old ad-hoc build with a Developer ID build and restarting does
  not create a Local Network settings entry.

The connection center now recognizes `ERR_ADDRESS_UNREACHABLE` and
`ERR_NETWORK_ACCESS_DENIED` as likely local-network privacy failures and offers
a native link to the relevant System Settings page.

## Upstream evidence

Apple Developer Forums contains reports matching this macOS 27 beta behavior:

- [Apps do not trigger pop-up asking for permission to access local network on
  macOS Sequoia/Tahoe](https://developer.apple.com/forums/thread/814226)
- [How to reset apps from Local Network privacy
  settings](https://developer.apple.com/forums/thread/766270)

Apple DTS notes that Local Network privacy is not managed by TCC, so
`tccutil reset` is not a reliable reset mechanism for this permission. A fresh
macOS user account can be used to test with a clean per-user Local Network
privacy state.

## Rejected workaround

Some community reports suggest disabling System Integrity Protection and
deleting Network Extension preference databases. Do not use that workaround:
it weakens system security and depends on undocumented implementation details.

## Resume plan

1. Update the test Mac to a newer macOS 27 beta or stable build.
2. Reinstall the latest notarized Termdock release.
3. Test the signed app against `https://<LAN-IP>:9834`; do not launch a substitute
   Electron binary.
4. If the prompt is still absent, repeat once in a new local macOS user account.
5. Capture a sysdiagnose immediately after the failed connection and file it
   through Feedback Assistant with this reproduction sequence.
6. Recheck the Local Network pane and the signed app's actual HTTP/WebSocket
   connection before closing this issue.

## Acceptance criteria

The issue is resolved only when:

- macOS shows the native permission prompt or lists Termdock in Local Network
  settings;
- the signed application loads the remote Termdock UI by private IP;
- its HTTP and WebSocket traffic remain connected after relaunch and reboot;
- the local CLI service and shared `~/.termdock` state are unaffected.
