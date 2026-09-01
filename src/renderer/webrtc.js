// Beam WebRTC mesh — one RTCPeerConnection per peer pair, perfect-negotiation
// pattern to avoid glare, deterministic offerer (lexicographically smaller
// peer id offers), ordered control data channel, and file-transfer channels.

import { state } from './state.js';
import { parseIceServers } from './config.js';

class Peer {
  constructor(mesh, peerId) {
    this.mesh = mesh;
    this.id = peerId;
    this.amOfferer = (state.selfId || '') < peerId; // lexicographic
    this.polite = !this.amOfferer;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.control = null;
    this.localTracks = new Map(); // track.id -> { track, stream, role, sender }

    this.pc = new RTCPeerConnection({ iceServers: mesh.iceServers });

    this.pc.onicecandidate = ({ candidate }) => {
      state.net.sendSignal(peerId, {
        candidate: candidate ? candidate.toJSON() : null,
      });
    };

    this._negTimer = null;
    this.pc.onnegotiationneeded = () => {
      if (this._negTimer) return;
      this._negTimer = setTimeout(async () => {
        this._negTimer = null;
        try {
          console.log('[webrtc] negotiate', this.id, 'signaling=' + this.pc.signalingState);
          this.makingOffer = true;
          await this.pc.setLocalDescription();
          state.net.sendSignal(this.id, {
            description: this.pc.localDescription.toJSON(),
          });
        } catch (err) {
          console.error('negotiation failed', err);
        } finally {
          this.makingOffer = false;
        }
      }, 50);
    };this.pc.ontrack = (event) => {
      console.log("[webrtc] ontrack", peerId, event.track.kind, event.track.id, "readyState=" + event.track.readyState, "muted=" + event.track.muted);
        event.track.onmute = () => console.log("[webrtc] remote track MUTED", peerId, event.track.kind);
        event.track.onunmute = () => console.log("[webrtc] remote track UNMUTED", peerId, event.track.kind);
        event.track.onended = () => console.log("[webrtc] remote track ENDED", peerId, event.track.kind);
        if (this.mesh.onRemoteTrack) {
          this.mesh.onRemoteTrack(peerId, event.track, event.streams);
        }
    };

    this.pc.ondatachannel = (event) => {
      const ch = event.channel;
      if (ch.label === 'control') {
        this.control = ch;
        this.setupControlChannel(ch);
      } else if (ch.label.startsWith('transfer-')) {
        if (this.mesh.onDataChannel) this.mesh.onDataChannel(peerId, ch);
      }
    };

    this.pc.oniceconnectionstatechange = () => { console.log("[webrtc] ICE", this.id, this.pc.iceConnectionState); };
    this.pc.onconnectionstatechange = () => {
      console.log("[webrtc] PC", peerId, this.pc.connectionState);
      if (this.mesh.onPeerStatus) this.mesh.onPeerStatus(peerId, this.pc.connectionState);
    };

    if (this.amOfferer) {
      this.control = this.pc.createDataChannel('control', { ordered: true });
      this.setupControlChannel(this.control);
    }
  }

  setupControlChannel(ch) {
    ch.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (this.mesh.onControlMessage) this.mesh.onControlMessage(this.id, msg);
    };
  }

  async handleSignal(data) {
    try {
      if (data.description) {
        const desc = data.description;
        const offerCollision =
          desc.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await this.pc.setLocalDescription();
          state.net.sendSignal(this.id, {
            description: this.pc.localDescription.toJSON(),
          });
        }
      } else if (data.candidate !== undefined) {
        if (data.candidate) {
          await this.pc.addIceCandidate(data.candidate);
        } else {
          await this.pc.addIceCandidate();
        }
      }
    } catch (err) {
      if (!this.ignoreOffer) console.error('signal handling error', err);
    }
  }

  addTrack(track, stream, role) {
    if (this.localTracks.has(track.id)) return;
    const sender = this.pc.addTrack(track, stream);
    console.log("[webrtc] addTrack", this.id, role, track.id, track.kind, "readyState=" + track.readyState);
    this.localTracks.set(track.id, { track, stream, role, sender });
  }

  removeTrack(track) {
    const entry = this.localTracks.get(track.id);
    if (entry) {
      try {
        this.pc.removeTrack(entry.sender);
      } catch {
        /* ignore */
      }
      this.localTracks.delete(track.id);
    }
  }

  getSender(track) {
    return this.localTracks.get(track.id)?.sender || null;
  }

  close() {
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }
}

export class MeshManager {
  constructor() {
    this.peers = new Map();
    this.iceServers = [];
    this.onRemoteTrack = null; // (peerId, track, streams)
    this.onControlMessage = null; // (peerId, msg)
    this.onDataChannel = null; // (peerId, channel)
    this.onPeerStatus = null; // (peerId, connectionState)
  }

  init() {
    this.iceServers = parseIceServers(
      state.config?.stunServers || [],
      state.config?.turnServers || []
    );
  }

  syncRoster(rosterMap) {
    const ids = new Set(rosterMap.keys());
    ids.delete(state.selfId);
    for (const id of ids) {
      if (!this.peers.has(id)) this.peers.set(id, new Peer(this, id));
    }
    for (const id of [...this.peers.keys()]) {
      if (!ids.has(id)) this.removePeer(id);
    }
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.close();
      this.peers.delete(peerId);
    }
  }

  handleSignal(from, data) {
    const peer = this.peers.get(from);
    if (peer) peer.handleSignal(data);
  }

  addLocalTrack(track, stream, role = 'media') {
    for (const peer of this.peers.values()) peer.addTrack(track, stream, role);
  }

  removeLocalTrack(track) {
    for (const peer of this.peers.values()) peer.removeTrack(track);
  }

  // Replace a local track in-place across all peers (avoids full renegotiation).
  replaceTrack(oldTrack, newTrack) {
    for (const peer of this.peers.values()) {
      const entry = peer.localTracks.get(oldTrack.id);
      if (!entry) continue;
      try {
        entry.sender.replaceTrack(newTrack);
      } catch {
        /* ignore */
      }
      peer.localTracks.delete(oldTrack.id);
      entry.track = newTrack;
      peer.localTracks.set(newTrack.id, entry);
    }
  }

  setContentHint(track, hint) {
    try {
      track.contentHint = hint;
    } catch {
      /* ignore */
    }
  }

  // maxBitrate (bps), maxFramerate (fps), scaleResolutionDownBy (number)
  applyTrackConstraints(track, { maxBitrate, maxFramerate, scaleResolutionDownBy }) {
    for (const peer of this.peers.values()) {
      const sender = peer.getSender(track);
      if (!sender) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        const enc = params.encodings[0];
        if (maxBitrate != null) enc.maxBitrate = maxBitrate;
        if (maxFramerate != null) enc.maxFramerate = maxFramerate;
        if (scaleResolutionDownBy != null) enc.scaleResolutionDownBy = scaleResolutionDownBy;
        sender.setParameters(params);
      } catch {
        /* best effort */
      }
    }
  }

  sendControl(peerId, msg) {
    const peer = this.peers.get(peerId);
    if (peer?.control && peer.control.readyState === 'open') {
      peer.control.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  createTransferChannel(peerId, label) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    return peer.pc.createDataChannel(label, { ordered: true });
  }

  destroy() {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }
}
