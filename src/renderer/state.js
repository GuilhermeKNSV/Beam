// Beam renderer shared state singleton.

export const state = {
  config: null,
  appInfo: null,

  // identity / room
  selfId: null,
  selfName: '',
  isOwner: false,
  ownerId: null,
  roomName: '',
  roomCode: '',
  ownerToken: null,

  // live roster: peerId -> { id, name, isOwner, inVC, streaming, deafened, muted }
  roster: new Map(),

  // subsystems (set during bootstrap)
  net: null,
  mesh: null,
  audio: null,

  // local VC state
  inVC: false,
  selfMuted: false,
  selfDeafened: false,

  // local screenshare state
  streaming: false,
  screenStream: null,
  screenVideoTrack: null,
  screenAudioTrack: null,
  screenSourceId: null,
  screenSourceName: '',
  screenSourceKind: 'screen', // 'screen' | 'window'

  // active transfer sessions: sessionId -> TransferSession
  transfers: new Map(),
  transferDirHandle: null,
  nextFileId: 1,

  // per-peer listen preferences
  peerVolume: new Map(), // peerId -> 0..200
  peerMutedForMe: new Set(), // peerId

  // watchers for UI refresh
  onRoster: null,
  onStreams: null,
  onTransfers: null,
};
