// Beam signaling client — WebSocket connection to the room server.

import { state } from './state.js';

export class NetClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.onDisconnected = null; // set by app
    this.onKicked = null;
  }

  connect(url, joinPayload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', ...joinPayload }));
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'welcome') {
          if (!settled) {
            settled = true;
            resolve(msg);
          }
          this.handleWelcome(msg);
        } else if (msg.type === 'error') {
          if (!settled) {
            settled = true;
            reject(new Error(msg.message || 'Failed to join'));
          }
        } else {
          this.handleMessage(msg);
        }
      };
      ws.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Connection closed'));
        }
        this.handleClose();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('Connection error'));
        }
      };
    });
  }

  handleWelcome(msg) {
    this.connected = true;
    state.selfId = msg.selfId;
    state.ownerId = msg.ownerId;
    state.roomName = msg.roomName;
    state.roomCode = msg.roomCode;
    state.isOwner = msg.youAreOwner;
    state.roster = new Map((msg.members || []).map((m) => [m.id, m]));
    if (state.onRoster) state.onRoster();
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'roster': {
        state.roster = new Map((msg.members || []).map((m) => [m.id, m]));
        if (state.onRoster) state.onRoster();
        break;
      }
      case 'signal': {
        if (state.mesh) state.mesh.handleSignal(msg.from, msg.data);
        break;
      }
      case 'kicked': {
        this.connected = false;
        this.ws = null;
        if (this.onKicked) this.onKicked(msg.reason || 'You were kicked');
        break;
      }
      case 'forced-state': {
        if (msg.muted === true && state.audio) {
          state.audio.setSelfMuted(true);
          state.selfMuted = true;
        } else if (msg.muted === false && state.audio) {
          state.audio.setSelfMuted(false);
          state.selfMuted = false;
        }
        if (msg.deafened === true && state.audio) {
          state.audio.setSelfDeafened(true);
          state.selfDeafened = true;
        } else if (msg.deafened === false && state.audio) {
          state.audio.setSelfDeafened(false);
          state.selfDeafened = false;
        }
        if (state.onRoster) state.onRoster();
        break;
      }
      default:
        break;
    }
  }

  handleClose() {
    if (!this.connected) return;
    this.connected = false;
    this.ws = null;
    if (this.onDisconnected) this.onDisconnected();
  }

  sendSignal(to, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', to, data }));
    }
  }

  sendState(patch) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'state', ...patch }));
    }
  }

  sendOwnerCommand(command, target) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ type: 'owner-command', token: state.ownerToken, command, target })
      );
    }
  }

  disconnect() {
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }
}
