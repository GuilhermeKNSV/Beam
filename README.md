# Beam

Beam is a local-first personal voice-call / screenshare / file-transfer desktop app — a minimal, private Discord replacement that runs entirely on your own machine. The host's computer runs a tiny embedded room server; peers connect directly to each other over WebRTC.

Built with **Electron** and **vanilla JavaScript ES modules** — no bundler, no TypeScript, no UI framework. Runtime dependencies are `electron` and `ws` only.

## Download / Run (Windows)

For end users who just want a double-click-and-run app — **no Node.js or npm required** — Beam is distributed as two prebuilt Windows executables:

| File | What it is |
| --- | --- |
| `Beam-Portable-1.1.0.exe` | **Portable** single-file app. No installation — double-click to run. Settings are stored in `%APPDATA%\beam`. |
| `Beam-Setup-1.1.0.exe` | **Installer** (NSIS). Installs Beam to a folder of your choice, adds Start Menu shortcuts, and registers an uninstaller. |

> **SmartScreen note:** these builds are **unsigned**, so on other machines Windows SmartScreen may show "Windows protected your PC". That is expected for unsigned builds — click **More info → Run anyway**. (This is a code-signing limitation, not an app problem.)

## Features

- **Home** — Host a room (name + optional password + port) or Enter a room (server address, room code, optional password).
- **Room** — live roster (owner crown + VC / streaming / deafened / muted badges), Voice / Screenshare / Files sections, and a settings panel.
- **Voice** — mesh audio, per-peer volume (0–200%) and mute-for-you, owner kick / mute-for-everyone / deafen, your own mic mute, deafen, and an input level meter.
- **Screenshare** — custom picker (per-monitor screens + live window list with thumbnails), quality controls (resolution / FPS / bitrate), Windows system-audio loopback, reconfigure without dropping viewers, and Discord-like watching with Picture-in-Picture.
- **Files** — roster-driven request/accept, bidirectional transfer over WebRTC data channels with per-file and total progress, speed, ETA, cancel, and no file-size limit (streamed in chunks).

## Setup

Requirements:

- **Node.js >= 20** (tested on Node 22)
- **Windows 10 / 11** (the app also runs on other platforms, but system-audio loopback is Windows-only)

```bash
npm install
npm start
```

### Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the app (GUI) |
| `npm run smoke` | Boot main process without a window, run self-checks, print `SMOKE OK`, exit 0 |
| `npm run dist` | Build Windows `portable` + `nsis` artifacts into `dist/` (electron-builder) |
| `node scripts/make-icon.js` | Regenerate `build/icon.ico` (dependency-free) |
| `node tests/server.test.js` | Standalone room-server tests (node:assert, no framework) |
| `node tests/transfer.test.js` | File-frame chunking/assembly unit tests (>= 50 MB payload) |

## Building the .exe yourself

If you want to produce the two Windows artifacts from source:

```bash
npm install
npm run dist
```

Output lands in `dist/`:

- `dist/Beam-Portable-1.1.0.exe` — portable single-file app
- `dist/Beam-Setup-1.1.0.exe` — NSIS installer

The first build downloads Electron and the NSIS toolchain, so it needs a network connection; later builds are cached.

> **PowerShell execution-policy note:** if `npm install` fails in PowerShell with an error about `npm.ps1` being disabled, either use `npm.cmd install` / `npm.cmd run dist` instead, or allow local scripts once with:
>
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```

## Hosting a room

1. Click **Host a room**.
2. Enter your display name, room name, optional password, and port (default `5310`).
3. Click **Start room**. The app starts the embedded server and joins as owner.
4. The room screen shows the **room code** and every **connect address** (all local IPv4s + port), each with a copy button.
5. Give joiners the address + room code (+ password, if set).

## Joining a room

1. Click **Enter a room**.
2. Enter your display name, the server address (`host:port`), and the room code.
3. Enter a password only if the room has one. The client first does `GET http://addr/info` to check availability and whether a password is required, then connects over WebSocket.

## Networking notes

- **LAN**: on the same network, give joiners any of the host's listed local IPv4 addresses. Windows Firewall will prompt to allow Node/Electron on first run — accept it for private networks.
- **Over the internet**: STUN usually suffices for typical NATs. Strict/symmetric NATs require a **TURN** server (configurable in Settings). The host must be reachable — port forwarding, or a VPN such as **Tailscale** (recommended; joiners then use the Tailscale IP).
- **Ports**: the host's room port must be reachable by joiners. Forward the chosen port (TCP) on the host's router when connecting across the internet.

## Settings guide

Open Settings from the home screen or the room header (gear icon):

- **Audio** — microphone and speaker (output) device pickers, mic volume, output volume, echo cancellation, noise suppression, auto gain control. Device lists refresh on `devicechange`.
- **Appearance** — dark/light base, accent color + presets, background tint + presets.
- **Picture-in-Picture** — **System PiP** (native `requestPictureInPicture()`: always-on-top, hidden from taskbar/Alt-Tab, draggable, corner-resizable) or **Custom PiP** (Document Picture-in-Picture API with overlay controls; may appear in Alt-Tab on some systems). This choice is exactly what controls Alt-Tab visibility.
- **Screenshare defaults** — resolution (Source / 2160p / 1440p / 1080p / 720p / 480p), FPS (24/30/60/120), bitrate (Auto or manual 2–80 Mbps), and "share computer sound" (Windows loopback).
- **Network** — free-text STUN and TURN lists (one per line; TURN supports `url username credential`). Defaults to a standard public STUN list. Strict NATs require a TURN server.
- **Stream privacy blacklist** — add windows by title prefix or executable name. Blacklisted windows are hidden from the window picker. (See Limitations.)

## Limitations

- **Per-app audio exclusion is not possible** with system loopback capture. Beam shares the whole system mix when "share computer sound" is on; there is no per-application audio blacklist (and none is faked in the UI).
- **Full-screen capture cannot hide blacklisted windows.** The blacklist applies to the window picker (and warns when sharing an entire screen); to exclude a window, share that window instead.
- **Mute-for-everyone and deafen are server-authorized but client-enforced** (cooperative). A modified client could ignore them.
- **Mesh topology** is comfortable up to roughly **8 peers**; larger rooms would need an SFU.
- **Exe-name blacklist matching is best-effort**: Electron's `desktopCapturer` does not expose the executable path, so "exe name" entries match against the window title.
- **Loopback system audio** is Windows-only and version-dependent; it degrades gracefully to no system audio when unsupported.

## Troubleshooting

- **Windows Firewall prompt**: allow access on private networks the first time you host; otherwise joiners cannot reach your room.
- **Missing audio devices**: if the device pickers are empty, check that the OS sees the device; grant microphone permission in Windows privacy settings. Reopen Settings after plugging in a device.
- **No system sound in screenshare**: confirm "Share computer sound" is on, that you're on Windows, and that your Electron build supports loopback capture.
- **Peers can't connect**: check the address/port, firewall, and whether a TURN server is needed (strict NAT). For cross-internet use, a VPN like Tailscale is the simplest fix.
- **Server unreachable**: Beam returns you to the home screen with a clear error. Re-check the address and that the host is still running.

## Project layout

```
beam/
├── package.json
├── README.md
├── src/
│   ├── main/
│   │   ├── main.js        # Electron main process, IPC, display-media handler, smoke mode
│   │   ├── server.js      # standalone room server (no Electron imports)
│   │   ├── config.js      # config load/save/validate (userData JSON)
│   │   └── preload.cjs    # sandboxed contextBridge
│   ├── shared/
│   │   └── transfer-frames.js  # binary file-frame codec (shared renderer/tests)
│   └── renderer/
│       ├── index.html, styles.css
│       └── *.js           # vanilla DOM modules (app, net, webrtc, audio, screenshare, files, …)
└── tests/
    ├── server.test.js
    └── transfer.test.js
```
