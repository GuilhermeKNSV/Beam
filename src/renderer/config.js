// Beam renderer config store + theme application.

import { state } from './state.js';

export const RESOLUTIONS = ['source', '2160p', '1440p', '1080p', '720p', '480p'];
export const FPS_OPTIONS = [24, 30, 60, 120];
export const ACCENT_PRESETS = ['#5865f2', '#3ba55d', '#f23f43', '#f0b232', '#eb459e', '#00a8fc'];
export const TINT_PRESETS = ['#0b0d14', '#101018', '#16121f', '#101816', '#1a1410', '#ffffff'];
export const DEFAULT_STUN = 'stun:stun.l.google.com:19302\nstun:stun1.l.google.com:19302';

export function resolutionScale(name) {
  switch (name) {
    case '2160p':
      return 1;
    case '1440p':
      return 1.5;
    case '1080p':
      return 2;
    case '720p':
      return 3;
    case '480p':
      return 4.5;
    default:
      return 1;
  }
}

export async function loadConfig() {
  const [config, appInfo] = await Promise.all([
    window.beam.getConfig(),
    window.beam.getAppInfo(),
  ]);
  state.config = config;
  state.appInfo = appInfo;
  applyTheme();
  return config;
}

export async function saveConfig() {
  state.config = await window.beam.setConfig(state.config);
  applyTheme();
  return state.config;
}

export function applyTheme() {
  const theme = state.config?.theme || { base: 'dark', accent: '#5865f2', backgroundTint: '#0b0d14' };
  const root = document.documentElement;
  const dark = theme.base !== 'light';
  root.dataset.theme = theme.base;

  const accent = theme.accent || '#5865f2';
  const tint = theme.backgroundTint || (dark ? '#0b0d14' : '#f4f5f8');

  root.style.setProperty('--accent', accent);
  root.style.setProperty('--bg-tint', tint);
  root.style.setProperty('--bg', tint);
  root.style.setProperty('--panel', dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)');
  root.style.setProperty('--panel-strong', dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
  root.style.setProperty('--border', dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)');
  root.style.setProperty('--text', dark ? '#e8eaf0' : '#181c24');
  root.style.setProperty('--text-muted', dark ? '#9aa0ae' : '#5c6270');
  root.style.setProperty('--danger', '#f23f43');
  root.style.setProperty('--success', '#3ba55d');
}

// Parse free-text STUN/TURN lists into RTCIceServer entries.
export function parseIceServers(stunLines, turnEntries) {
  const ice = [];
  for (const line of stunLines || []) {
    const v = String(line).trim();
    if (v) ice.push({ urls: v });
  }
  for (const entry of turnEntries || []) {
    if (!entry) continue;
    // Support object format { urls, username, credential }
    if (typeof entry === 'object' && entry.urls) {
      const s = { urls: entry.urls };
      if (entry.username) s.username = entry.username;
      if (entry.credential) s.credential = entry.credential;
      ice.push(s);
      continue;
    }
    // Support string format "turn:url username credential"
    const parts = String(entry).trim().split(/\s+/);
    if (!parts[0]) continue;
    const s = { urls: parts[0] };
    if (parts[1]) s.username = parts[1];
    if (parts[2]) s.credential = parts[2];
    ice.push(s);
  }
  return ice;
}
