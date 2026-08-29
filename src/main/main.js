// Beam — Electron main process.
//
// Runs the room server (for hosts), wires IPC between renderer and Node,
// provides desktop capture sources for the custom screenshare picker, and
// supports a `--smoke` mode that boots without a window for CI verification.

import { app, BrowserWindow, ipcMain, session, desktopCapturer, Menu } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createRoom } from './server.js';
import * as upnp from './upnp.js';
import { getPublicIp } from './public-ip.js';
import * as updater from './updater.js';
import { loadConfig, saveConfig, validateConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

const isSmoke = process.argv.includes('--smoke');

// Active hosted room (created by the host from the renderer).
let activeRoom = null;
let forwardedPort = null;
// Currently selected capture source (id + name + kind), stored at pick time so
// the display-media handler can re-match it robustly against a fresh
// enumeration (Windows window ids can change between enumerations).
let selectedSource = null;

function logToFile(line) {
  const iso = new Date().toISOString();
  console.log(line);
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'beam.log'), `${iso} ${line}\n`);
  } catch {
    /* logging must never break capture */
  }
}

// 'window:12345:0' -> 'window:12345' (drops the unstable trailing sequence
// component so the stable hwnd portion can still match). Screens are left as-is.
function normalizeSourceId(id) {
  if (typeof id !== 'string') return '';
  const parts = id.split(':');
  if (parts[0] === 'window' && parts.length > 1) {
    return parts.slice(0, -1).join(':');
  }
  return id;
}

function getLocalIPv4s() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Resolve the stored pick-time selection against a fresh enumeration.
// Returns { source, matched, via } where `matched` is false when no source
// could be resolved (the caller must then reject rather than guess).
function resolveSelectedSource(sources) {
  const sel = selectedSource;
  if (!sel || !sel.id) return { source: null, matched: false, via: 'none' };

  // 1. Exact id match.
  const exact = sources.find((s) => s.id === sel.id);
  if (exact) return { source: exact, matched: true, via: 'exact' };

  // 2. Normalized id prefix (stable hwnd portion for windows).
  const wantNorm = normalizeSourceId(sel.id);
  const prefix = sources.find((s) => normalizeSourceId(s.id) === wantNorm);
  if (prefix) return { source: prefix, matched: true, via: 'prefix' };

  // 3. Type + name match.
  const kindPrefix = sel.kind === 'window' ? 'window:' : 'screen:';
  const byName = sources.find(
    (s) => s.id.startsWith(kindPrefix) && sel.name && s.name === sel.name
  );
  if (byName) return { source: byName, matched: true, via: 'name' };

  // 4. Deterministic screen fallback (never an arbitrary `sources[0]`).
  //    Only used when the selection itself was a screen that no longer
  //    enumerates with the same id/name (e.g. a monitor was unplugged).
  if (sel.kind !== 'window') {
    const screen = sources.find((s) => s.id.startsWith('screen:'));
    if (screen) return { source: screen, matched: true, via: 'screen-fallback' };
  }

  return { source: null, matched: false, via: 'none' };
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const wantAudio = Boolean(request.audioRequested);
    // Loopback system audio is only supported on Windows in this Electron line.
    const audio =
      wantAudio && process.platform === 'win32' ? 'loopback' : undefined;

    logToFile(
      `[capture] request audio=${wantAudio} selected=${JSON.stringify(selectedSource)}`
    );

    desktopCapturer
      .getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      })
      .then((sources) => {
        const resolved = resolveSelectedSource(sources);
        if (!resolved.matched || !resolved.source) {
          logToFile(
            `[capture] no source matched (selected=${JSON.stringify(selectedSource)}, via=${resolved.via}) — rejecting request`
          );
          callback({});
          return;
        }
        logToFile(
          `[capture] matched source id=${resolved.source.id} name=${JSON.stringify(resolved.source.name)} via=${resolved.via} audio=${audio || 'none'}`
        );
        callback({ video: resolved.source, audio });
      })
      .catch((err) => {
        logToFile(`[capture] enumeration failed: ${err && err.message ? err.message : err}`);
        callback({});
      });
  });
}

function registerIpc(config) {
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_event, next) => {
    const merged = saveConfig(app.getPath('userData'), next || {});
    Object.assign(config, merged);
    return config;
  });

  ipcMain.handle('update:check', async () => {
    return updater.checkForUpdate(app.getVersion());
  });

  ipcMain.handle('update:download', async (_event, url) => {
    return new Promise((resolve) => {
      updater.downloadUpdate(url, (downloaded, total) => {
        const pct = Math.round((downloaded / total) * 100);
        BrowserWindow.getAllWindows()[0]?.webContents.send('update:progress', { downloaded, total, pct });
      }).then(resolve);
    });
  });

ipcMain.handle('update:apply', async (_event, exePath) => {
  const { spawn } = await import('child_process');
  spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
});
ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    isSmoke,
  }));

  ipcMain.handle('room:host', async (_event, options = {}) => {
    if (activeRoom) {
      await activeRoom.close().catch(() => {});
      activeRoom = null;
    }
    const room = await createRoom({
      port: options.port || 0,
      roomName: options.roomName || 'Beam Room',
      password: options.password || undefined,
      memberCap: options.memberCap || 16,
      version: app.getVersion(),
    });
    activeRoom = room;

    // Try UPnP port forwarding
    let upnpOk = false;
    let publicIp = null;
    const upnpResult = await upnp.forward(room.port);
    if (upnpResult.ok) {
      upnpOk = true;
      forwardedPort = room.port;
      if (upnpResult.externalIp) publicIp = upnpResult.externalIp;
    }
    // Fallback: get public IP from external service
    if (!publicIp) {
      try { publicIp = await getPublicIp(); } catch { /* ignore */ }
    }

    logToFile('[upnp] ok=' + upnpOk + ' publicIp=' + publicIp);

    return {
      port: room.port,
      roomCode: room.roomCode,
      ownerToken: room.ownerToken,
      roomName: room.roomName,
      hasPassword: room.hasPassword,
      addresses: getLocalIPv4s(),
      publicIp,
      upnpOk,
    };
  });

  ipcMain.handle('room:close', async () => {
    if (forwardedPort) {
      upnp.remove(forwardedPort).catch(() => {});
      forwardedPort = null;
    }
    if (activeRoom) {
      await activeRoom.close().catch(() => {});
      activeRoom = null;
    }
    return true;
  });

  ipcMain.handle('capture:sources', async (_event, type) => {
    const types = type === 'window' ? ['window'] : ['screen'];
    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: { width: 480, height: 270 },
      fetchWindowIcons: true,
    });
    // Serialize each source independently so one window with an unreadable
    // thumbnail/icon cannot fail the whole enumeration (which would hide every
    // other window from the picker).
    return sources.map((s) => {
      let thumbnail = null;
      let appIcon = null;
      try {
        thumbnail = s.thumbnail ? s.thumbnail.toDataURL() : null;
      } catch {
        /* skip thumbnail */
      }
      try {
        appIcon = s.appIcon ? s.appIcon.toDataURL() : null;
      } catch {
        /* skip icon */
      }
      return {
        id: s.id,
        name: s.name,
        display_id: s.display_id,
        appIcon,
        thumbnail,
      };
    });
  });

  ipcMain.handle('capture:select', (_event, source) => {
    if (source && typeof source === 'object') {
      selectedSource = {
        id: source.id,
        name: source.name || '',
        kind: source.kind === 'window' ? 'window' : 'screen',
      };
    } else {
      // Legacy/string path (screens) — keep working.
      selectedSource = { id: String(source), name: '', kind: 'screen' };
    }
    logToFile(`[capture] selected ${JSON.stringify(selectedSource)}`);
    return true;
  });
}

async function runSmoke() {
  console.log('[smoke] booting Beam main process...');
  const configDir = app.getPath('userData');
  const config = loadConfig(configDir);
  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new Error(`config validation failed: ${problems.join('; ')}`);
  }
  console.log(`[smoke] config loaded OK (userData=${configDir})`);

  registerIpc(config);
  registerDisplayMediaHandler();
  console.log('[smoke] IPC handlers + display-media handler registered');

  // Validate the standalone room server module boots on an ephemeral port.
  const room = await createRoom({ port: 0, roomName: 'smoke' });
  await room.close();
  console.log(`[smoke] room server module OK (code=${room.roomCode})`);

  console.log('SMOKE OK');
  app.exit(0);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0b0d14',
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // No default menu bar; keep a devtools shortcut for development.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF12 = input.key === 'F12';
    const isDevShortcut =
      (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
    if (isF12 || isDevShortcut) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.loadFile(path.join(RENDERER_DIR, 'index.html'));
  return win;
}

app.whenReady().then(async () => {
  // Remove the default File/Edit/View/Window/Help menu bar.
  Menu.setApplicationMenu(null);

  if (isSmoke) {
    await runSmoke();
    return;
  }

  const config = loadConfig(app.getPath('userData'));
  registerIpc(config);
  registerDisplayMediaHandler();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
