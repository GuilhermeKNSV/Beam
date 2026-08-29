// Beam voice channel (VC) — join/leave, mic/deafen toggles, level meter,
// center-of-screen participant tiles, and the persistent bottom control bar.

import { state } from './state.js';
import { $, el, clear, toast, clamp } from './util.js';
import * as screenshare from './screenshare.js';

let meterBar = null;

export async function toggleVoice() {
  if (state.inVC) {
    await leaveVoice();
  } else {
    await joinVoice();
  }
}

async function joinVoice() {
  try {
    const track = await state.audio.startMic();
    state.mesh.addLocalTrack(track, new MediaStream([track]), 'mic');
    state.inVC = true;
    state.selfMuted = false;
    state.selfDeafened = false;
    state.net.sendState({ inVC: true, muted: false, deafened: false });
    renderVoicePanel();
    toast('Joined voice', 'success');
  } catch (err) {
    toast(`Could not access microphone: ${err.message}`, 'error');
  }
}

async function leaveVoice() {
  if (state.audio.micTrack) {
    state.mesh.removeLocalTrack(state.audio.micTrack);
  }
  state.audio.stopMic();
  state.inVC = false;
  state.selfMuted = false;
  state.selfDeafened = false;
  meterBar = null;
  state.net.sendState({ inVC: false, muted: false, deafened: false });
  renderVoicePanel();
}

export function setSelfMuted(muted) {
  state.audio.setSelfMuted(muted);
  state.selfMuted = muted;
  state.net.sendState({ muted });
  renderVoicePanel();
}

export function setSelfDeafened(deafened) {
  state.audio.setSelfDeafened(deafened);
  state.selfDeafened = deafened;
  state.net.sendState({ deafened });
  renderVoicePanel();
}

export function setPeerVolume(peerId, volume) {
  const v = clamp(volume, 0, 200);
  state.peerVolume.set(peerId, v);
  state.audio.setPeerVolume(peerId, v);
}

export function togglePeerMute(peerId) {
  if (state.peerMutedForMe.has(peerId)) {
    state.peerMutedForMe.delete(peerId);
    state.audio.setPeerMuted(peerId, false);
  } else {
    state.peerMutedForMe.add(peerId);
    state.audio.setPeerMuted(peerId, true);
  }
}

function updateMeter(level) {
  if (meterBar) {
    meterBar.style.width = `${Math.min(100, level * 200)}%`;
  }
}

function voiceTile(member) {
  const self = member.id === state.selfId;
  const badges = [];
  if (member.deafened) badges.push(el('span', { class: 'badge deaf' }, 'Deafened'));
  if (member.muted) badges.push(el('span', { class: 'badge mute' }, 'Muted'));

  return el(
    'div',
    { class: `vc-tile${self ? ' self' : ''}`, dataset: { peerId: member.id } },
    el('div', { class: 'vc-avatar' }, (member.name || '?').charAt(0).toUpperCase()),
    el('div', { class: 'vc-tile-name' }, member.name + (self ? ' (you)' : '')),
    el('div', { class: 'roster-badges' }, ...badges)
  );
}

export function renderVoicePanel() {
  const panel = $('#panel-voice');
  if (!panel) return;
  clear(panel);

  if (!state.inVC) {
    panel.append(
      el('div', { class: 'vc-idle' },
        el('h3', {}, 'Voice'),
        el('p', { class: 'hint' }, 'Join the voice channel to talk with everyone in the room.'),
        el('button', { class: 'btn primary big', onclick: toggleVoice }, 'Join Voice'))
    );
    renderControlBar();
    return;
  }

  const inVc = [...state.roster.values()].filter((m) => m.inVC);
  const tiles = el('div', { class: 'vc-tiles' }, ...inVc.map(voiceTile));

  panel.append(
    el('h3', {}, 'Voice'),
    el('div', { class: 'vc-live' },
      el('span', { class: 'live-dot' }, `In voice (${inVc.length})`),
      tiles)
  );
  renderControlBar();
}

export function renderControlBar() {
  const bar = $('#control-bar');
  if (!bar) return;

  if (!state.inVC) {
    bar.classList.add('hidden');
    meterBar = null;
    return;
  }

  bar.classList.remove('hidden');
  const name = state.selfName || 'You';
  const nameEl = $('#control-bar-name');
  const avatarEl = $('#control-bar-avatar');
  if (nameEl) nameEl.textContent = name;
  if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase();

  const muteBtn = $('#ctrl-mute');
  if (muteBtn) {
    muteBtn.classList.toggle('active', state.selfMuted);
    muteBtn.textContent = state.selfMuted ? '🔇' : '🎙️';
    muteBtn.title = state.selfMuted ? 'Unmute' : 'Mute';
  }
  const deafBtn = $('#ctrl-deafen');
  if (deafBtn) {
    deafBtn.classList.toggle('active', state.selfDeafened);
    deafBtn.textContent = state.selfDeafened ? '🔊' : '🔈';
    deafBtn.title = state.selfDeafened ? 'Undeafen' : 'Deafen';
  }

  meterBar = $('#control-bar-meter-fill');
  state.audio.onLevel = updateMeter;
}
