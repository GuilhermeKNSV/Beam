// Beam room screen — channel rail, grouped member sidebar, owner connection
// info, persistent voice control bar, and the per-person context menu.

import { state } from './state.js';
import { $, $$, el, clear, showView, showContextMenu, toast } from './util.js';
import * as voice from './voice.js';
import * as screenshare from './screenshare.js';
import * as files from './files.js';

let hostInfo = null;

function activateChannel(channel) {
  $$('.channel').forEach((b) => b.classList.toggle('active', b.dataset.channel === channel));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${channel}`));
}

export function init() {
  $$('.channel').forEach((btn) => {
    btn.addEventListener('click', () => activateChannel(btn.dataset.channel));
  });

  $('#btn-leave').addEventListener('click', () => {
    window.appLeaveRoom();
  });

  $('#btn-settings-room').addEventListener('click', () => {
    window.appOpenSettings();
  });

  $('#btn-copy-code').addEventListener('click', () => {
    copy(state.roomCode || '', 'Room code');
  });

  // Persistent voice control bar.
  $('#ctrl-mute').addEventListener('click', () => voice.setSelfMuted(!state.selfMuted));
  $('#ctrl-deafen').addEventListener('click', () => voice.setSelfDeafened(!state.selfDeafened));
  $('#ctrl-share').addEventListener('click', () => screenshare.startStreaming());
  $('#ctrl-disconnect').addEventListener('click', () => voice.toggleVoice());
}

export function onEnterRoom(info) {
  hostInfo = info || null;
  $('#room-name').textContent = state.roomName || 'Room';
  $('#room-self').textContent = state.isOwner ? 'you are the owner' : `joined as ${state.selfName}`;
  const verEl = document.getElementById('app-version');
  if (verEl) verEl.textContent = state.appInfo && state.appInfo.version ? 'Beam v' + state.appInfo.version : '';
  $('#room-code-chip').textContent = state.roomCode || '';
  $('#rail-avatar').textContent = (state.roomName || 'B').charAt(0).toUpperCase();
  clear($('#roster-list'));
  renderConnectionInfo();
  voice.renderVoicePanel();
  screenshare.renderScreensharePanel();
  files.renderFilesPanel();
  activateChannel('voice');
  showView('room');
}

export function renderConnectionInfo() {
  const box = 
$('#connect-info');
  if (!box) return;
  if (!hostInfo || !state.isOwner) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  clear(box);

  const addresses = [];
  if (hostInfo.publicIp) {
    const pubAddr = hostInfo.publicIp + ':' + hostInfo.port;
    addresses.push({ addr: pubAddr, label: 'PUBLIC (internet)', cls: 'public-addr' });
  }
  for (const ip of (hostInfo.addresses || [])) {
    addresses.push({ addr: ip + ':' + hostInfo.port, label: 'Local', cls: '' });
  }

  const addressList = el(
    'div',
    { class: 'addresses' },
    ...addresses.map((a) =>
      el('div', { class: 'address-row' + (a.cls ? ' ' + a.cls : '') },
        el('span', {}, a.label + ' — ' + a.addr),
        el('button', { class: 'mini-btn', onclick: () => copy(a.addr, 'Address') }, 'Copy')
      )
    )
  );

  const items = [
    el('div', { class: 'connect-label' }, 'Connect addresses'),
    addressList,
  ];

  if (hostInfo.upnpOk) {
    items.push(el('p', { class: 'hint upnp-ok' }, '✅ UPnP active — port is open. Friends can connect from the internet.'));
  } else {
    items.push(el('p', { class: 'hint upnp-warn' }, '⚠ UPnP not available — same network/VPN only, or forward port ' + hostInfo.port + ' in your router.'));
  }

  const hintMsg = hostInfo.upnpOk
    ? 'Share the PUBLIC address + room code with your friend' + (hostInfo.hasPassword ? ' + the password.' : '.')
    : 'Share an address + room code' + (hostInfo.hasPassword ? ' + the password.' : '.');
  items.push(el('p', { class: 'hint' }, hintMsg));

  box.append(...items);
}


function copy(text, label) {
  if (!text) return;
  navigator.clipboard
    .writeText(text)
    .then(() => toast(`${label} copied`, 'success'))
    .catch(() => toast('Copy failed', 'error'));
}

export function renderRoster() {
  const list = $('#roster-list');
  if (!list) return;
  clear(list);

  const members = [...state.roster.values()];
  const inVoice = members.filter((m) => m.inVC);
  const online = members.filter((m) => !m.inVC);

  if (inVoice.length) {
    list.append(el('div', { class: 'roster-group-label' }, `IN VOICE — ${inVoice.length}`));
    for (const m of inVoice) list.append(rosterItem(m));
  }
  if (online.length) {
    list.append(el('div', { class: 'roster-group-label' }, `ONLINE — ${online.length}`));
    for (const m of online) list.append(rosterItem(m));
  }
  if (!members.length) {
    list.append(el('div', { class: 'empty' }, 'No one here yet.'));
  }
}

function rosterItem(member) {
  const isSelf = member.id === state.selfId;
  const badges = [];
  if (member.isOwner) badges.push(el('span', { class: 'badge owner', title: 'Owner' }, '👑'));
  if (member.streaming) badges.push(el('span', { class: 'badge stream' }, 'Streaming'));
  if (member.deafened) badges.push(el('span', { class: 'badge deaf' }, 'Deafened'));
  if (member.muted) badges.push(el('span', { class: 'badge mute' }, 'Muted'));

  const item = el(
    'div',
    { class: `roster-item${isSelf ? ' self' : ''}`, dataset: { peerId: member.id } },
    el('div', { class: `avatar${member.inVC ? ' speaking' : ''}` }, (member.name || '?').charAt(0).toUpperCase()),
    el('span', { class: 'roster-name' }, member.name + (isSelf ? ' (you)' : '')),
    el('span', { class: 'roster-badges' }, ...badges)
  );

  if (!isSelf) {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openPersonMenu(member, e.clientX, e.clientY);
    });
    item.addEventListener('click', () => openPersonMenu(member, window.innerWidth / 2, window.innerHeight / 2));
  }
  return item;
}

function openPersonMenu(member, x, y) {
  const items = [];
  items.push({ type: 'item', label: 'Request files', action: () => files.requestFiles(member.id) });

  if (member.inVC) {
    items.push({ type: 'separator' });
    items.push({
      type: 'slider',
      label: 'Volume for you',
      min: 0,
      max: 200,
      step: 1,
      value: state.peerVolume.get(member.id) ?? 100,
      oninput: (v) => voice.setPeerVolume(member.id, v),
    });
    items.push({
      type: 'toggle',
      label: 'Mute for you',
      checked: state.peerMutedForMe.has(member.id),
      action: () => voice.togglePeerMute(member.id),
    });
  }

  if (state.isOwner && !member.isOwner) {
    items.push({ type: 'separator' });
    items.push({ type: 'item', label: 'Kick from room', action: () => state.net.sendOwnerCommand('kick', member.id) });
    items.push({
      type: 'item',
      label: member.muted ? 'Unmute for everyone' : 'Mute for everyone',
      action: () => state.net.sendOwnerCommand(member.muted ? 'unmute-for-everyone' : 'mute-for-everyone', member.id),
    });
    items.push({
      type: 'item',
      label: member.deafened ? 'Undeafen' : 'Deafen',
      action: () => state.net.sendOwnerCommand(member.deafened ? 'undeafen' : 'deafen', member.id),
    });
  }

  showContextMenu(x, y, items);
}

export function getHostInfo() {
  return hostInfo;
}
