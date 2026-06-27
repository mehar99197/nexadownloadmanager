#pragma once

// NativeHostRegistrar — makes the desktop app self-register its native-messaging
// host manifest on every startup, so the browser extension can always reach
// nexa-host WITHOUT a manual install step.
//
// Why this exists: a browser shows "Specified native messaging host not found"
// whenever it can't locate the com.nexa.host.json manifest in its per-user
// NativeMessagingHosts directory. Relying on the installer (.deb postinst / NSIS
// registry writes) or a manual native-host/install.sh means a fresh machine — or
// a plain `./build/nexa` dev run — has no manifest, so the error recurs every
// time. Registering from the running app fixes it once, for ALL machines:
//   * the host binary path is derived from THIS executable's location at runtime,
//     so it's always correct (dev build, /usr/lib/nexa, or Windows install dir);
//   * the extension ids are pinned (Chrome via the manifest "key", Firefox via
//     the gecko id), so allowed_origins always matches the loaded extension;
//   * it's idempotent — safe to run on every launch.

namespace nexa {

// Write/refresh the com.nexa.host manifest for every supported browser
// (Chrome, Chromium, Edge, Brave, Firefox) in the current user's profile.
// No-op if the nexa-host binary can't be found next to this executable.
void registerNativeHost();

} // namespace nexa
