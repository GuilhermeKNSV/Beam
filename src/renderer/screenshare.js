// Beam screenshare — streaming (custom picker, quality, reconfigure),
// local preview + self-listing, watching with per-stream volume / PiP /
// fullscreen, and the privacy blacklist.

import { state } from './state.js';
import { $, $$, el, clear, toast, clamp } from './util.js';
import { resolutionScale, RESOLUTIONS, FPS_OPTIONS } from './config.js';

const remote = new Map(); // peerId -> { videoEl, track, volume, muted }
let watchingId = null; // member id (self or remote) currently in theater
let selfVideoEl = null; // local preview element while streaming
let picker = null;
let pickerSelected = null; // { id, name, kind }
let pipWindow = null;
let fullscreenBound = false;
let fsHideTimer = null;

function isSelf(peerId) {
  return peerId === state.selfId;
}

function createVideoEl() {
  const v = el('video', { autoplay: '', playsinline: '' });
  v.muted = true; // audio is routed through the WebAudio graph / kept off for self
  return v;
}

function getSelfPreviewVideo() {
  if (!state.screenStream) return null;
  if (!selfVideoEl) selfVideoEl = createVideoEl();
  if (selfVideoEl.srcObject !== state.screenStream) {
    selfVideoEl.srcObject = state.screenStream;
    selfVideoEl.play().catch(() => {});
  }
  return selfVideoEl;
}

function getStreamMember(peerId) {
  if (isSelf(peerId)) {
    return {
      id: state.selfId,
      name: state.selfName || 'You',
      isOwner: state.isOwner,
      inVC: state.inVC,
      streaming: state.streaming,
      deafened: state.selfDeafened,
      muted: state.selfMuted,
    };
  }
  return state.roster.get(peerId) || null;
}

function getStreamVideo(peerId) {
  if (isSelf(peerId)) return getSelfPreviewVideo();
  return remote.get(peerId)?.videoEl || null;
}

function matchBlacklist(name) {
  const entries = state.config?.blacklist || [];
  const n = name.toLowerCase();
  for (const entry of entries) {
    const p = String(entry.pattern || '').toLowerCase();
    if (!p) continue;
    if (entry.kind === 'title') {
      if (n.startsWith(p)) return entry;
    } else if (entry.kind === 'exe') {
      // Electron does not expose the executable path via desktopCapturer; we
      // best-effort match the window title against the configured exe name.
      if (n.startsWith(p) || n.includes(p)) return entry;
    }
  }
  return null;
}

function qualityToParams() {
  const q = state.config.screenshare || {};
  const scale = resolutionScale(q.resolution || 'source');
  const maxFramerate = q.fps || 30;
  const maxBitrate = q.bitrate === 'auto' ? undefined : (q.bitrateMbps || 8) * 1_000_000;
  return { maxBitrate, maxFramerate, scaleResolutionDownBy: scale };
}

export function isStreaming() {
  return state.streaming;
}

// ---- streaming ----

export async function startStreaming() {
  if (state.streaming) {
    await reconfigure();
    return;
  }
  await openPicker(false);
}

export async function reconfigure() {
  await openPicker(true);
}

function openPicker(reconfigureMode) {
  return new Promise((resolve) => {
    closePicker();
    picker = el('div', { class: 'overlay', id: 'picker-overlay' });
    const panel = el('div', { class: 'picker-panel', role: 'dialog', 'aria-label': 'Share your screen' });

    const sourceGrid = el('div', { class: 'source-grid' });
    let mode = 'screen';
    let sources = [];
    const warning = el(
      'p',
      { class: 'warning-banner' },
      "Blacklist can't hide windows from a full-screen capture — share the window instead."
    );

    const resolutionSel = el('select');
    for (const r of RESOLUTIONS) resolutionSel.append(el('option', { value: r }, r === 'source' ? 'Source' : r));
    resolutionSel.value = state.config.screenshare.resolution || 'source';

    const fpsSel = el('select');
    for (const f of FPS_OPTIONS) fpsSel.append(el('option', { value: String(f) }, `${f} fps`));
    fpsSel.value = String(state.config.screenshare.fps || 30);

    const bitrateSel = el('select');
    bitrateSel.append(el('option', { value: 'auto' }, 'Auto'));
    bitrateSel.append(el('option', { value: 'manual' }, 'Manual (2–80 Mbps)'));
    bitrateSel.value = state.config.screenshare.bitrate === 'auto' ? 'auto' : 'manual';
    const bitrateSlider = el('input', { type: 'range', min: 2, max: 80, step: 1, value: state.config.screenshare.bitrateMbps || 8 });
    const bitrateLabel = el('span', { class: 'field-value' }, `${state.config.screenshare.bitrateMbps || 8} Mbps`);
    bitrateSlider.addEventListener('input', () => {
      bitrateLabel.textContent = `${bitrateSlider.value} Mbps`;
      state.config.screenshare.bitrate = 'manual';
      bitrateSel.value = 'manual';
      state.config.screenshare.bitrateMbps = Number(bitrateSlider.value);
    });

    const soundToggle = el('input', { type: 'checkbox' });
    soundToggle.checked = !!state.config.screenshare.shareComputerSound;

    async function loadSources() {
      clear(sourceGrid);
      try {
        sources = await window.beam.getSources(mode);
      } catch (err) {
        sourceGrid.append(el('div', { class: 'empty' }, `Could not list sources: ${err.message}`));
        warning.style.display = 'none';
        return;
      }
      let hidden = 0;
      for (const source of sources) {
        if (mode === 'window' && matchBlacklist(source.name || '')) {
          hidden += 1;
          continue; // filtered out of the picker by the user's blacklist only
        }
        // Show every enumerated window, including untitled ones.
        const label = source.name && source.name.trim() ? source.name : '(untitled window)';
        const card = el(
          'div',
          { class: 'source-card', dataset: { id: source.id }, onclick: () => selectSource(source) },
          source.thumbnail
            ? el('img', { class: 'source-thumb', src: source.thumbnail, alt: label })
            : el('div', { class: 'source-thumb empty' }),
          el('div', { class: 'source-name', title: source.id }, label)
        );
        sourceGrid.append(card);
      }
      if (mode === 'window' && hidden > 0) {
        sourceGrid.append(el('p', { class: 'hint flagged' }, `${hidden} blacklisted window(s) hidden`));
      }
      if (!sources.length) sourceGrid.append(el('div', { class: 'empty' }, 'No sources found.'));
      warning.style.display = mode === 'screen' ? 'block' : 'none';
    }

    function selectSource(source) {
      pickerSelected = { id: source.id, name: source.name || '', kind: mode };
      $$('.source-card', sourceGrid).forEach((c) => c.classList.toggle('selected', c.dataset.id === source.id));
    }

    const tabRow = el('div', { class: 'picker-tabs' });
    const screenTab = el('button', { class: 'tab-btn active' }, 'Entire screen');
    const windowTab = el('button', { class: 'tab-btn' }, 'Window');
    screenTab.addEventListener('click', () => { mode = 'screen'; screenTab.classList.add('active'); windowTab.classList.remove('active'); pickerSelected = null; loadSources(); });
    windowTab.addEventListener('click', () => { mode = 'window'; windowTab.classList.add('active'); screenTab.classList.remove('active'); pickerSelected = null; loadSources(); });
    const refreshBtn = el('button', { class: 'mini-btn', title: 'Refresh windows', onclick: loadSources }, 'Refresh');
    tabRow.append(screenTab, windowTab, refreshBtn);

    const qualityRow = el(
      'div',
      { class: 'picker-quality' },
      el('label', {}, 'Resolution ', resolutionSel),
      el('label', {}, 'FPS ', fpsSel),
      el('label', {}, 'Bitrate ', bitrateSel),
      el('div', { class: 'slider-row' }, bitrateSlider, bitrateLabel),
      el('label', { class: 'checkbox-row' }, soundToggle, ' Share computer sound')
    );

    const buttons = el('div', { class: 'picker-actions' });
    const cancelBtn = el('button', { class: 'btn' }, 'Cancel');
    const startBtn = el('button', { class: 'btn primary' }, reconfigureMode ? 'Apply' : 'Start streaming');
    cancelBtn.addEventListener('click', () => { closePicker(); resolve(null); });
    startBtn.addEventListener('click', async () => {
      if (!pickerSelected) {
        toast('Pick a screen or window first', 'error');
        return;
      }
      startBtn.disabled = true;
      try {
        await beginCapture(pickerSelected, {
          resolution: resolutionSel.value,
          fps: Number(fpsSel.value),
          bitrate: bitrateSel.value === 'auto' ? 'auto' : Number(bitrateSlider.value),
          shareSound: soundToggle.checked,
        }, reconfigureMode);
        closePicker();
        resolve(true);
      } catch (err) {
        toast(`Could not start stream: ${err.message}`, 'error');
        startBtn.disabled = false;
      }
    });
    buttons.append(cancelBtn, startBtn);

    panel.append(
      el('h3', {}, reconfigureMode ? 'Reconfigure stream' : 'Share your screen'),
      tabRow,
      warning,
      sourceGrid,
      qualityRow,
      buttons
    );
    picker.append(panel);
    picker.addEventListener('mousedown', (e) => { if (e.target === picker) { closePicker(); resolve(null); } });
    document.body.append(picker);
    loadSources();
  });
}

function closePicker() {
  if (picker) {
    picker.remove();
    picker = null;
    pickerSelected = null;
  }
}

async function beginCapture(selected, quality, reconfigureMode) {
  const shareSound = !!quality.shareSound;
  const scale = resolutionScale(quality.resolution);
  const maxFramerate = quality.fps;
  const maxBitrate = quality.bitrate === 'auto' ? undefined : quality.bitrate * 1_000_000;

  state.config.screenshare.resolution = quality.resolution;
  state.config.screenshare.fps = quality.fps;
  state.config.screenshare.bitrate = quality.bitrate === 'auto' ? 'auto' : 'manual';
  state.config.screenshare.bitrateMbps = quality.bitrate === 'auto' ? (state.config.screenshare.bitrateMbps || 8) : quality.bitrate;
  state.config.screenshare.shareComputerSound = shareSound;
  await window.beam.setConfig(state.config);

  await window.beam.selectSource(selected);

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: maxFramerate },
      audio: shareSound,
    });
  } catch (err) {
    // The main process rejects when the picked source can no longer be matched.
    const hint =
      selected.kind === 'window'
        ? 'Your selected window may have closed — reopen the picker and choose it again.'
        : 'Your selected screen may no longer be available.';
    throw new Error(`${hint} (${err && err.message ? err.message : 'capture denied'})`);
  }

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0] || null;
  const contentHint = maxFramerate >= 60 ? 'motion' : 'detail';
  state.mesh.setContentHint(videoTrack, contentHint);

  if (reconfigureMode && state.streaming) {
    // Replace tracks in place so viewers are not dropped.
    if (state.screenVideoTrack && videoTrack) {
      state.mesh.replaceTrack(state.screenVideoTrack, videoTrack);
    }
    if (audioTrack) {
      if (state.screenAudioTrack) state.mesh.replaceTrack(state.screenAudioTrack, audioTrack);
      else state.mesh.addLocalTrack(audioTrack, stream, 'screen-audio');
    } else if (state.screenAudioTrack) {
      state.mesh.removeLocalTrack(state.screenAudioTrack);
    }
    stopOldStreamTracks(state.screenStream, videoTrack, audioTrack);
  } else {
    if (videoTrack) state.mesh.addLocalTrack(videoTrack, stream, 'screen-video');
    if (audioTrack) state.mesh.addLocalTrack(audioTrack, stream, 'screen-audio');
  }

  if (videoTrack) {
    state.mesh.applyTrackConstraints(videoTrack, {
      maxBitrate,
      maxFramerate,
      scaleResolutionDownBy: scale,
    });
  }

  state.screenStream = stream;
  state.screenVideoTrack = videoTrack;
  state.screenAudioTrack = audioTrack;
  state.screenSourceId = selected.id;
  state.screenSourceName = selected.name || '';
  state.screenSourceKind = selected.kind;
  state.streaming = true;
  state.net.sendState({ streaming: true });
  renderScreensharePanel();
}

function stopOldStreamTracks(oldStream, keepVideo, keepAudio) {
  if (!oldStream) return;
  for (const t of oldStream.getTracks()) {
    if (t === keepVideo || t === keepAudio) continue;
    t.stop();
  }
}

export function stopStreaming() {
  if (!state.streaming) return;
  if (state.screenVideoTrack) state.mesh.removeLocalTrack(state.screenVideoTrack);
  if (state.screenAudioTrack) state.mesh.removeLocalTrack(state.screenAudioTrack);
  if (state.screenStream) {
    for (const t of state.screenStream.getTracks()) t.stop();
  }
  state.streaming = false;
  state.screenStream = null;
  state.screenVideoTrack = null;
  state.screenAudioTrack = null;
  state.screenSourceId = null;
  state.screenSourceName = '';
  if (selfVideoEl) {
    selfVideoEl.pause();
    selfVideoEl.srcObject = null;
    selfVideoEl = null;
  }
  if (watchingId === state.selfId) watchingId = null;
  state.net.sendState({ streaming: false });
  renderScreensharePanel();
}

export function toggleSound() {
  if (state.screenAudioTrack) {
    state.screenAudioTrack.enabled = !state.screenAudioTrack.enabled;
    renderScreensharePanel();
  } else {
    toast('No system audio track is being shared', 'info');
  }
}

// ---- remote streams / watching ----

export function onRemoteVideo(peerId, track) {
  let entry = remote.get(peerId);
  if (!entry) {
    const videoEl = createVideoEl();
    videoEl.srcObject = new MediaStream([track]);
    videoEl.play()
      .then(() => console.log("[screenshare] remote video PLAYING", peerId))
      .catch(err => console.error("[screenshare] remote video play() FAILED", peerId, err.message, err.name));
    entry = { videoEl, track, volume: 100, muted: false };
    remote.set(peerId, entry);
  } else if (entry.track !== track) {
    entry.videoEl.srcObject = new MediaStream([track]);
    entry.videoEl.play()
      .then(() => console.log("[screenshare] remote video PLAYING", peerId))
      .catch(err => console.error("[screenshare] remote video play() FAILED", peerId, err.message, err.name));
    entry.track = track;
  }
  refreshStreamsList();
}

export function onRemoteAudio() {
  // Screen audio is routed to the audio graph by app.js; nothing extra here.
}

export function refresh() {
  // Drop entries for peers who are no longer streaming.
  for (const [peerId, entry] of [...remote.entries()]) {
    const member = state.roster.get(peerId);
    if (!member || !member.streaming) {
      entry.videoEl.pause();
      entry.videoEl.srcObject = null;
      state.audio?.removePeerScreenAudio(peerId);
      if (watchingId === peerId) stopWatching();
      remote.delete(peerId);
    }
  }
  refreshStreamsList();
}

function refreshStreamsList() {
  const list = $('#stream-list');
  if (!list) return;
  clear(list);

  const streamers = [];
  if (state.streaming) streamers.push(getStreamMember(state.selfId));
  for (const m of state.roster.values()) {
    if (m.streaming && m.id !== state.selfId) streamers.push(m);
  }

  if (!streamers.length) {
    list.append(el('div', { class: 'empty' }, 'No live streams.'));
    return;
  }

  for (const m of streamers) {
    const vid = getStreamVideo(m.id);
    const thumb = vid || el('div', { class: 'source-thumb empty' });
    const label = m.name + (isSelf(m.id) ? ' (you)' : '');
    const card = el(
      'div',
      { class: 'stream-card', dataset: { peerId: m.id }, onclick: () => watch(m.id) },
      el('div', { class: 'stream-thumb-slot' }, thumb),
      el('div', { class: 'stream-name' }, label)
    );
    list.append(card);
  }
}

export function watch(peerId) {
  watchingId = peerId;
  renderScreensharePanel();
}

export function stopWatching() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  watchingId = null;
  renderScreensharePanel();
}

// ---- theater / fullscreen ----

function syncTheaterVideo() {
  const slot = document.getElementById('theater-video-slot');
  const vid = watchingId ? getStreamVideo(watchingId) : null;
  if (slot && vid && !slot.contains(vid)) slot.append(vid);
}

function armFullscreenAutoHide() {
  clearTimeout(fsHideTimer);
  fsHideTimer = setTimeout(() => {
    const btn = document.getElementById('theater-leave-fs');
    if (btn) btn.classList.add('hidden');
  }, 2000);
}

function showFullscreenLeaveBtn() {
  const btn = document.getElementById('theater-leave-fs');
  if (btn) btn.classList.remove('hidden');
  armFullscreenAutoHide();
}

function onFullscreenChange() {
  const theater = document.getElementById('theater');
  if (!theater) return;
  if (document.fullscreenElement === theater) {
    theater.classList.add('is-fullscreen');
    showFullscreenLeaveBtn();
  } else {
    theater.classList.remove('is-fullscreen');
    clearTimeout(fsHideTimer);
    const btn = document.getElementById('theater-leave-fs');
    if (btn) btn.classList.add('hidden');
  }
}

function bindFullscreenListeners() {
  if (fullscreenBound) return;
  fullscreenBound = true;
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('mousemove', () => {
    const theater = document.getElementById('theater');
    if (theater && document.fullscreenElement === theater) showFullscreenLeaveBtn();
  });
}

async function toggleTheaterFullscreen() {
  const theater = document.getElementById('theater');
  if (!theater) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    bindFullscreenListeners();
    await theater.requestFullscreen();
  }
}

async function exitFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
}

function renderTheater(panel) {
  const member = getStreamMember(watchingId);
  const vid = getStreamVideo(watchingId);
  const selfStream = isSelf(watchingId);
  const name = member ? member.name + (selfStream ? ' (you)' : '') : 'Screen';

  const videoSlot = el('div', { id: 'theater-video-slot', class: 'theater-video-slot' });
  if (vid) videoSlot.append(vid);

  const volumeLabel = el('span', { id: 'theater-volume-label', class: 'field-value' }, `${remote.get(watchingId)?.volume ?? 100}%`);
  const volumeSlider = el('input', {
    id: 'theater-volume',
    type: 'range',
    min: 0,
    max: 200,
    step: 1,
    value: remote.get(watchingId)?.volume ?? 100,
    oninput: (e) => setViewerVolume(Number(e.target.value)),
  });
  const muteBtn = el('button', {
    id: 'theater-mute',
    class: 'btn',
    onclick: toggleViewerMute,
  }, remote.get(watchingId)?.muted ? '🔇 Unmute for me' : '🔊 Mute for me');

  const controls = el(
    'div',
    { class: 'theater-controls' },
    el('span', { class: 'theater-name' }, name),
    !selfStream ? volumeSlider : null,
    !selfStream ? volumeLabel : null,
    !selfStream ? muteBtn : null,
    el('button', { class: 'btn', onclick: togglePiP }, 'Picture-in-Picture'),
    el('button', { class: 'btn', onclick: toggleTheaterFullscreen }, 'Fullscreen'),
    el('button', { class: 'btn danger', onclick: stopWatching }, 'Stop watching')
  );

  const leaveFs = el('button', { id: 'theater-leave-fs', class: 'btn theater-leave-fs hidden', onclick: exitFullscreen }, 'Leave fullscreen');

  const theater = el('div', { id: 'theater', class: 'theater' }, videoSlot, controls, leaveFs);
  panel.append(theater);
  syncTheaterVideo();
}

export function setViewerVolume(v) {
  if (isSelf(watchingId)) return;
  const entry = remote.get(watchingId);
  if (!entry) return;
  entry.volume = clamp(v, 0, 200);
  state.audio.setScreenVolume(watchingId, entry.volume);
  const label = $('#theater-volume-label');
  if (label) label.textContent = `${entry.volume}%`;
}

export function toggleViewerMute() {
  if (isSelf(watchingId)) return;
  const entry = remote.get(watchingId);
  if (!entry) return;
  entry.muted = !entry.muted;
  state.audio.setScreenMuted(watchingId, entry.muted);
  const btn = $('#theater-mute');
  if (btn) btn.textContent = entry.muted ? '🔇 Unmute for me' : '🔊 Mute for me';
}

export async function togglePiP() {
  const vid = getStreamVideo(watchingId);
  if (!vid) return;
  const mode = state.config?.pipMode || 'system';

  if (mode === 'custom' && window.documentPictureInPicture) {
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    await enterCustomPiP(vid);
  } else {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (typeof vid.requestPictureInPicture === 'function') {
      await vid.requestPictureInPicture();
    } else {
      toast('Picture-in-Picture is not supported', 'error');
    }
  }
}

async function enterCustomPiP(videoEl) {
  const win = await window.documentPictureInPicture.requestWindow({ width: 640, height: 360 });
  pipWindow = win;
  const doc = win.document;
  doc.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
  doc.body.innerHTML =
    '<div id="pip-container" style="position:relative;width:100vw;height:100vh;">' +
    '<div style="position:absolute;top:8px;right:8px;z-index:10;">' +
    '<button id="pip-close" style="background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:6px;padding:6px 10px;cursor:pointer;">✕ Close</button>' +
    '</div></div>';
  const container = doc.getElementById('pip-container');
  videoEl.style.width = '100%';
  videoEl.style.height = '100%';
  videoEl.controls = true;
  container.prepend(videoEl);
  doc.getElementById('pip-close').addEventListener('click', () => win.close());
  win.addEventListener('pagehide', () => {
    if (pipWindow === win) {
      const slot = document.getElementById('theater-video-slot');
      if (slot && !slot.contains(videoEl)) {
        videoEl.style.width = '';
        videoEl.style.height = '';
        videoEl.controls = false;
        slot.append(videoEl);
      }
      pipWindow = null;
    }
  });
}

// ---- panel ----

export function renderScreensharePanel() {
  const panel = $('#panel-screenshare');
  if (!panel) return;
  clear(panel);

  if (watchingId) {
    renderTheater(panel);
    return;
  }

  // My stream controls
  if (state.streaming) {
    panel.append(
      el('div', { class: 'my-stream' },
        el('span', { class: 'live-dot' }, 'You are live'),
        el('div', { class: 'stream-actions' },
          el('button', { class: 'btn', onclick: reconfigure }, 'Reconfigure'),
          el('button', {
            class: 'btn',
            onclick: toggleSound,
          }, state.screenAudioTrack?.enabled ? '🔊 Disable sound' : '🔇 Enable sound'),
          el('button', { class: 'btn danger', onclick: stopStreaming }, 'End stream'))
      )
    );
  } else {
    panel.append(
      el('div', { class: 'vc-idle' },
        el('h3', {}, 'Screenshare'),
        el('p', { class: 'hint' }, 'Share your screen standalone (no microphone) or start from inside Voice to combine both.'),
        el('button', { class: 'btn primary big', onclick: startStreaming }, 'Start streaming'))
    );
  }

  // Live streams (includes your own preview while streaming)
  panel.append(el('h4', {}, 'Live streams'));
  panel.append(el('div', { id: 'stream-list', class: 'stream-list' }));

  refreshStreamsList();
}
