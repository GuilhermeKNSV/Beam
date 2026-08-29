// Beam renderer entry point — bootstraps subsystems and wires everything.

import { loadConfig, applyTheme } from './config.js';
import { state } from './state.js';
import { AudioEngine } from './audio.js';
import { NetClient } from './net.js';
import { MeshManager } from './webrtc.js';
import { showView, toast } from './util.js';
import * as home from './home.js';
import * as room from './room.js';
import * as voice from './voice.js';
import * as screenshare from './screenshare.js';
import * as files from './files.js';
import { openSettings } from './settings.js';
import * as updaterUi from './updater-ui.js';

state.audio = new AudioEngine();
state.net = new NetClient();
state.mesh = new MeshManager();

function wireCallbacks() {
  state.net.onDisconnected = () => {
    leaveRoom();
    toast('Disconnected from server', 'error');
  };

  state.net.onKicked = (reason) => {
    leaveRoom();
    toast(`Kicked: ${reason}`, 'error');
  };

  state.mesh.onRemoteTrack = (peerId, track, streams) => {
    const hasVideo = (streams || []).some((s) => s.getVideoTracks().length > 0);
    if (track.kind === 'audio') {
      if (hasVideo) state.audio.addRemoteScreenAudio(peerId, track);
      else state.audio.addRemoteTrack(peerId, track);
    } else if (track.kind === 'video') {
      screenshare.onRemoteVideo(peerId, track, streams);
    }
  };

  state.mesh.onControlMessage = (peerId, msg) => files.handleControl(peerId, msg);
  state.mesh.onDataChannel = (peerId, channel) => files.handleDataChannel(peerId, channel);

  state.onRoster = () => {
    state.mesh.syncRoster(state.roster);
    room.renderRoster();
    voice.renderVoicePanel();
    screenshare.refresh();
    files.refresh();
  };
}

async function hostRoom({ name, roomName, password, port }) {
  const info = await window.beam.hostRoom({ roomName, password, port });
  state.selfName = name;
  state.ownerToken = info.ownerToken;
  state.roomCode = info.roomCode;
  state.roomName = info.roomName;
  state.config.displayName = name;
  await window.beam.setConfig(state.config);

  await state.net.connect(`ws://127.0.0.1:${info.port}`, {
    name,
    roomCode: info.roomCode,
    ownerToken: info.ownerToken,
  });
  room.onEnterRoom(info);
}

async function enterRoom({ name, address, roomCode, password }) {
  let info;
  try {
    const res = await fetch(`http://${address}/info`);
    if (!res.ok) throw new Error('unreachable');
    info = await res.json();
  } catch {
    throw new Error(`Cannot reach ${address} — check the address and port`);
  }
  if (info.hasPassword && !password) {
    throw new Error('This room requires a password');
  }

  state.selfName = name;
  state.config.displayName = name;
  await window.beam.setConfig(state.config);

  await state.net.connect(`ws://${address}`, { name, roomCode, password });
  room.onEnterRoom(null);
}

async function leaveRoom() {
  if (state.streaming) screenshare.stopStreaming();
  if (state.audio.micTrack) state.mesh.removeLocalTrack(state.audio.micTrack);
  state.audio.destroy();
  state.mesh.destroy();
  state.net.disconnect();
  if (state.isOwner) {
    try {
      await window.beam.closeRoom();
    } catch {
      /* ignore */
    }
  }
  state.roster = new Map();
  state.selfId = null;
  state.isOwner = false;
  state.ownerToken = null;
  state.inVC = false;
  state.streaming = false;
  state.selfMuted = false;
  state.selfDeafened = false;
  state.transfers.clear();
  state.peerVolume.clear();
  state.peerMutedForMe.clear();
  updaterUi.init();
  showView('home');
}


async function bootstrap() {
  try {
    state.appInfo = await window.beam.getAppInfo();
    await loadConfig();
  } catch (err) {
    toast(`Could not load config: ${err.message}`, 'error');
  }
  state.mesh.init();
  wireCallbacks();

  home.init({
    onHost: hostRoom,
    onEnter: enterRoom,
    openSettings,
  });
  room.init();

  window.appLeaveRoom = () => leaveRoom();
  window.appOpenSettings = () => openSettings();

    updaterUi.init();
  showView('home');
}

bootstrap();
