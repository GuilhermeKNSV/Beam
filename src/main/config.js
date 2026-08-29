// Beam user config — JSON file persisted in app.getPath('userData').
// Pure Node module (no Electron imports) so it can be loaded/validated in
// smoke mode and unit-tested without a full Electron runtime.

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE_NAME = 'config.json';

export const DEFAULT_CONFIG = {
  version: 1,
  displayName: '',
  micDeviceId: 'default',
  speakerDeviceId: 'default',
  micVolume: 100, // 0..200
  outputVolume: 100, // 0..200
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  theme: {
    base: 'dark', // 'dark' | 'light'
    accent: '#5865f2',
    backgroundTint: '#0b0d14',
  },
  pipMode: 'system', // 'system' | 'custom'
  screenshare: {
    resolution: 'source', // source | 2160p | 1440p | 1080p | 720p | 480p
    fps: 30, // 24 | 30 | 60 | 120
    bitrate: 'auto', // 'auto' | number (Mbps)
    bitrateMbps: 8,
    shareComputerSound: true,
  },
  stunServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302', 'stun:stun4.l.google.com:19302'],
  turnServers: [
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  blacklist: [], // [{ kind: 'title' | 'exe', pattern: '...' }]
};

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(override)) return out;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function configFilePath(baseDir) {
  return path.join(baseDir, CONFIG_FILE_NAME);
}

export function loadConfig(baseDir) {
  const file = configFilePath(baseDir);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('config root is not an object');
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return deepMerge(DEFAULT_CONFIG, {});
  }
}

export function saveConfig(baseDir, config) {
  fs.mkdirSync(baseDir, { recursive: true });
  const normalized = deepMerge(DEFAULT_CONFIG, config || {});
  fs.writeFileSync(configFilePath(baseDir), JSON.stringify(normalized, null, 2));
  return normalized;
}

export function validateConfig(config) {
  // Basic shape validation — returns array of problems (empty = valid).
  const problems = [];
  if (!isPlainObject(config)) {
    problems.push('config is not an object');
    return problems;
  }
  if (!isPlainObject(config.theme)) problems.push('theme must be an object');
  if (!isPlainObject(config.screenshare)) problems.push('screenshare must be an object');
  if (!Array.isArray(config.stunServers)) problems.push('stunServers must be an array');
  if (!Array.isArray(config.turnServers)) problems.push('turnServers must be an array');
  if (!Array.isArray(config.blacklist)) problems.push('blacklist must be an array');
  return problems;
}
