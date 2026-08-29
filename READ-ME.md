# Beam

Standalone voice call, screenshare & file transfer app. No server needed — just download and run.

## Features
- Voice calls with per-user volume control
- Screen sharing with quality settings (480p to 4K)
- Unlimited file sharing (no size limits)
- Room passwords with brute-force protection
- UPnP auto port-forwarding
- Built-in auto-updater
- Anti-cheat safe (no process injection)

## Download

Get the latest portable exe from [Releases](https://github.com/GuilhermeKNSV/Beam/releases).

## Usage
1. **Host**: Open Beam, click "Host a room", set a password, share the address + room code
2. **Join**: Open Beam, click "Enter a room", paste the address, enter room code + password

## Building

```bash
npm install
npm run dist
```

## For Friends

Download `Beam-Portable-*.exe` from the releases page. No install needed — just run it.

If the host has UPnP on their router, friends can connect from the internet directly.
Otherwise, use the same network or a VPN (like Tailscale or Radmin).