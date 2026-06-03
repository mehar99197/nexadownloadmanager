# Bundled external tools — pinned versions

Nexa drives three external binaries. The AppImage bundles them so users need
nothing installed; this file PINS the versions that ship in a given build so a
release is reproducible and regressions are traceable to a tool bump.

| Tool    | Pinned version | Role                                                       |
|---------|----------------|------------------------------------------------------------|
| yt-dlp  | 2026.03.17     | YouTube / Udemy / site-video extraction (the fragile one)  |
| ffmpeg  | 8.1.1          | HLS/DASH mux, audio extract, subtitle embed                |
| aria2c  | 1.37.0         | Fast multi-connection fragment downloads for yt-dlp        |

## Updating

- **yt-dlp** rots fastest (sites change). Users can self-update in place from the
  app: gear menu → **“Update video tools (yt-dlp)…”** (runs `yt-dlp -U`). When
  bumping the bundled copy, update the version above and re-run the AppImage build.
- **ffmpeg / aria2** rarely need bumping; pin them so a distro upgrade can't
  silently change behaviour in the bundle.

## Build note

The AppImage packaging copies these exact binaries into `usr/bin/` and
`src/main.cpp` prepends `$APPDIR/usr/bin` to `PATH` so the bundled copies win
over any (possibly older/newer) system install at runtime.
