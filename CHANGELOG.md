# Changelog

## 1.4.98 - 2026-08-29

### Added

- Added an Agent operations panel for scheduled automations, durable collaboration groups and terminal-session search.
- Added persistent Agent conversation recovery, recent resume history and one-click restoration after interrupted terminal sessions.
- Added macOS desktop remote file drop uploads: files dropped onto a terminal connected to another service are uploaded to that service's `/tmp` directory before its returned path is inserted.
- Added video preview rotation, fullscreen controls and press-and-hold 2× playback.

### Improved

- Improved Agent discovery, launch defaults, plugin metadata and new-session composition.
- Improved video scrubbing by coalescing seeks and settling on the exact requested frame.
- Improved viewport, keyboard and startup scheduling to reduce initial loading flashes and mobile layout jumps.
- Improved notification focus handoff so the requested session is promoted before the app resumes.
- Improved terminal session persistence and deletion handling to avoid reviving stale sessions.

### Fixed

- Fixed desktop file drops inserting a Mac-local path into terminals hosted by LAN or public Termdock services.
- Fixed interrupted Agent sessions losing enough metadata to resume their native conversation safely.
