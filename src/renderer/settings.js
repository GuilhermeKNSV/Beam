// Beam settings panel — rendered as an overlay, accessible from home and room.

import { state } from './state.js';
import { saveConfig, applyTheme, ACCENT_PRESETS, TINT_PRESETS, RESOLUTIONS, FPS_OPTIONS } from './config.js';
import { el, clear, toast } from './util.js';

let overlay = null;
let deviceRefreshBound = false;

async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devices.filter((d) => d.kind === 'audioinput'),
      outputs: devices.filter((d) => d.kind === 'audiooutput'),
    };
  } catch {
    return { inputs: [], outputs: [] };
  }
}

function field(labelText, control) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, labelText), control);
}

function slider(value, min, max, step, oninput) {
  const input = el('input', { type: 'range', min, max, step, value });
  const valueEl = el('span', { class: 'field-value' }, String(value));
  input.addEventListener('input', () => {
    valueEl.textContent = String(input.value);
    oninput(Number(input.value));
  });
  return el('div', { class: 'slider-row' }, input, valueEl);
}

function toggle(checked, onchange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onchange(input.checked));
  return el('span', { class: 'toggle' }, input, el('span', { class: 'toggle-track' }));
}

function select(options, value, onchange) {
  const sel = el('select');
  for (const opt of options) {
    sel.append(el('option', { value: opt.value }, opt.label));
  }
  sel.value = value;
  sel.addEventListener('change', () => onchange(sel.value));
  return sel;
}

export function isSettingsOpen() {
  return !!overlay;
}

export function openSettings() {
  closeSettings();

  const cfg = state.config;
  overlay = el('div', { class: 'overlay', id: 'settings-overlay' });
  const panel = el('div', { class: 'settings-panel', role: 'dialog', 'aria-label': 'Settings' });

  const header = el(
    'div',
    { class: 'settings-header' },
    el('h2', {}, 'Settings'),
    el(
      'button',
      { class: 'icon-btn', title: 'Close', onclick: closeSettings },
      '✕'
    )
  );

  // ---- Audio ----
  const micSelect = select([], cfg.micDeviceId, async (v) => {
    cfg.micDeviceId = v;
    await saveConfig();
  });
  const speakerSelect = select([], cfg.speakerDeviceId, async (v) => {
    cfg.speakerDeviceId = v;
    await saveConfig();
    if (state.audio) await state.audio.setOutputDevice(v);
  });

  const audioSection = el(
    'div',
    { class: 'settings-section' },
    el('h3', {}, 'Audio'),
    field('Microphone', micSelect),
    field('Speaker (output)', speakerSelect),
    field(
      'Mic volume',
      slider(cfg.micVolume, 0, 200, 1, async (v) => {
        cfg.micVolume = v;
        state.audio?.setMicVolume(v);
        await saveConfig();
      })
    ),
    field(
      'Output volume',
      slider(cfg.outputVolume, 0, 200, 1, async (v) => {
        cfg.outputVolume = v;
        state.audio?.setOutputVolume(v);
        await saveConfig();
      })
    ),
    field('Echo cancellation', toggle(cfg.echoCancellation, async (v) => { cfg.echoCancellation = v; await saveConfig(); })),
    field('Noise suppression', toggle(cfg.noiseSuppression, async (v) => { cfg.noiseSuppression = v; await saveConfig(); })),
    field('Auto gain control', toggle(cfg.autoGainControl, async (v) => { cfg.autoGainControl = v; await saveConfig(); }))
  );

  // ---- Appearance ----
  const accentPicker = el('input', { type: 'color', value: cfg.theme.accent });
  accentPicker.addEventListener('input', () => {
    cfg.theme.accent = accentPicker.value;
    applyTheme();
    saveConfig();
  });
  const tintPicker = el('input', { type: 'color', value: cfg.theme.backgroundTint });
  tintPicker.addEventListener('input', () => {
    cfg.theme.backgroundTint = tintPicker.value;
    applyTheme();
    saveConfig();
  });

  const accentPresets = el(
    'div',
    { class: 'swatches' },
    ...ACCENT_PRESETS.map((c) =>
      el('button', {
        class: 'swatch',
        style: { background: c },
        title: c,
        onclick: () => {
          cfg.theme.accent = c;
          accentPicker.value = c;
          applyTheme();
          saveConfig();
        },
      })
    )
  );
  const tintPresets = el(
    'div',
    { class: 'swatches' },
    ...TINT_PRESETS.map((c) =>
      el('button', {
        class: 'swatch',
        style: { background: c },
        title: c,
        onclick: () => {
          cfg.theme.backgroundTint = c;
          tintPicker.value = c;
          applyTheme();
          saveConfig();
        },
      })
    )
  );

  const appearanceSection = el(
    'div',
    { class: 'settings-section' },
    el('h3', {}, 'Appearance'),
    field(
      'Theme',
      select(
        [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ],
        cfg.theme.base,
        async (v) => {
          cfg.theme.base = v;
          applyTheme();
          await saveConfig();
        }
      )
    ),
    field('Accent color', el('div', { class: 'color-row' }, accentPicker, accentPresets)),
    field('Background tint', el('div', { class: 'color-row' }, tintPicker, tintPresets))
  );

  // ---- Picture-in-Picture ----
  const pipSection = el(
    'div',
    { class: 'settings-section' },
    el('h3', {}, 'Picture-in-Picture'),
    el(
      'p',
      { class: 'hint' },
      'System PiP uses native video.requestPictureInPicture(): always-on-top, hidden from taskbar and Alt-Tab, draggable and corner-resizable. Custom PiP uses the Document Picture-in-Picture API with overlay controls but may appear in Alt-Tab on some systems.'
    ),
    field(
      'PiP mode',
      select(
        [
          { value: 'system', label: 'System PiP (hidden from Alt-Tab)' },
          { value: 'custom', label: 'Custom PiP window' },
        ],
        cfg.pipMode,
        async (v) => {
          cfg.pipMode = v;
          await saveConfig();
        }
      )
    )
  );

  // ---- Screenshare defaults ----
  const bitrateMode = cfg.screenshare.bitrate === 'auto' ? 'auto' : 'manual';
  const bitrateSlider = slider(
    bitrateMode === 'auto' ? 8 : cfg.screenshare.bitrateMbps,
    2,
    80,
    1,
    async (v) => {
      cfg.screenshare.bitrateMbps = v;
      cfg.screenshare.bitrate = 'manual';
      bitrateModeSel.value = 'manual';
      await saveConfig();
    }
  );
  const bitrateModeSel = select(
    [
      { value: 'auto', label: 'Auto' },
      { value: 'manual', label: 'Manual (2–80 Mbps)' },
    ],
    bitrateMode,
    async (v) => {
      cfg.screenshare.bitrate = v;
      await saveConfig();
    }
  );

  const screenshareSection = el(
    'div',
    { class: 'settings-section' },
    el('h3', {}, 'Screenshare defaults'),
    field(
      'Resolution',
      select(
        RESOLUTIONS.map((r) => ({ value: r, label: r === 'source' ? 'Source' : r })),
        cfg.screenshare.resolution,
        async (v) => {
          cfg.screenshare.resolution = v;
          await saveConfig();
        }
      )
    ),
    field(
      'FPS',
      select(
        FPS_OPTIONS.map((f) => ({ value: String(f), label: `${f} fps` })),
        String(cfg.screenshare.fps),
        async (v) => {
          cfg.screenshare.fps = Number(v);
          await saveConfig();
        }
      )
    ),
    field('Bitrate', el('div', { class: 'bitrate-row' }, bitrateModeSel, bitrateSlider)),
    field('Share computer sound (Windows loopback)', toggle(cfg.screenshare.shareComputerSound, async (v) => { cfg.screenshare.shareComputerSound = v; await saveConfig(); }))
  );

  // ---- Network ----
  const stunTextarea = el('textarea', { rows: 3, spellcheck: 'false' }, cfg.stunServers.join('\n'));
  const turnTextarea = el('textarea', { rows: 3, spellcheck: 'false' }, cfg.turnServers.join('\n'));
  stunTextarea.addEventListener('change', async () => {
    cfg.stunServers = stunTextarea.value.split('\n').map((s) => s.trim()).filter(Boolean);
    await saveConfig();
  });
  turnTextarea.addEventListener('change', async () => {
    cfg.turnServers = turnTextarea.value.split('\n').map((s) => s.trim()).filter(Boolean);
    await saveConfig();
  });

  const networkSection = el(
    'div',
    { class: 'settings-section' },
    el('h3', {}, 'Network (STUN / TURN)'),
    field('STUN servers (one per line)', stunTextarea),
    field('TURN servers (one per line: url [username credential])', turnTextarea),
    el(
      'p',
      { class: 'hint' },
      'STUN is usually enough for most home networks. Strict NATs (or symmetric NAT) require a TURN server for peer connections over the internet.'
    )
  );

  // ---- Privacy blacklist ----
  const blacklistList = el('div', { class: 'blacklist-list' });
  const kindSel = select(
    [
      { value: 'title', label: 'Window title prefix' },
      { value: 'exe', label: 'Executable name' },
    ],
    'title'
  );
  const patternInput = el('input', { type: 'text', placeholder: 'e.g. Notepad or notepad.exe' });

  function renderBlacklist() {
    clear(blacklistList);
    if (!cfg.blacklist.length) {
      blacklistList.append(el('p', { class: 'hint' }, 'No entries. Blacklisted windows are hidden from the window picker.'));
      return;
    }
    for (let i = 0; i < cfg.blacklist.length; i += 1) {
      const entry = cfg.blacklist[i];
      blacklistList.append(
        el(
          'div',
          { class: 'blacklist-item' },
          el('span', { class: 'badge' }, entry.kind === 'title' ? 'title' : 'exe'),
          el('span', { class: 'blacklist-pattern' }, entry.pattern),
          el('button', {
            class: 'icon-btn danger',
            title: 'Remove',
            onclick: async () => {
              cfg.blacklist.splice(i, 1);
              renderBlacklist();
              await saveConfig();
            },
          }, '✕')
        )
      );
    }
  }

  const addBtn = el('button', { class: 'btn' }, 'Add to blacklist');
  addBtn.addEventListener('click', async () => {
    const pattern = patternInput.value.trim();
    if (!pattern) return;
    cfg.blacklist.push({ kind: kindSel.value, pattern });
    patternInput.value = '';
    renderBlacklist();
    await saveConfig();
  });

  const privacySection = el(
    'div',
    { class: 'settings-section' },
    el('h3', {}, 'Stream privacy blacklist'),
    el(
      'p',
      { class: 'hint' },
      'Blacklisted windows are filtered out of the window picker and flagged if they match. Blacklist can\u2019t hide windows from a full-screen capture — share the window instead.'
    ),
    el('div', { class: 'blacklist-add' }, kindSel, patternInput, addBtn),
    blacklistList
  );

  renderBlacklist();

  panel.append(
    header,
    audioSection,
    appearanceSection,
    pipSection,
    screenshareSection,
    networkSection,
    privacySection
  );
  overlay.append(panel);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeSettings();
  });
  document.body.append(overlay);

  // Populate device lists.
  (async () => {
    const { inputs, outputs } = await enumerateDevices();
    clear(micSelect);
    micSelect.append(el('option', { value: 'default' }, 'Default microphone'));
    for (const d of inputs) micSelect.append(el('option', { value: d.deviceId }, d.label || `Microphone (${d.deviceId.slice(0, 8)})`));
    micSelect.value = cfg.micDeviceId;

    clear(speakerSelect);
    speakerSelect.append(el('option', { value: 'default' }, 'Default speaker'));
    for (const d of outputs) speakerSelect.append(el('option', { value: d.deviceId }, d.label || `Speaker (${d.deviceId.slice(0, 8)})`));
    speakerSelect.value = cfg.speakerDeviceId;
  })();

  if (!deviceRefreshBound) {
    deviceRefreshBound = true;
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      if (overlay) {
        toast('Audio devices changed — reopening settings to refresh', 'info');
      }
    });
  }
}

export function closeSettings() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}
