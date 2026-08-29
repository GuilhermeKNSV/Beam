// Beam audio engine — WebAudio graph for mic capture, per-peer volume,
// output device selection, input level metering, and self mute/deafen.

import { state } from './state.js';
import { clamp } from './util.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;

    this.micRawStream = null;
    this.micTrack = null; // outgoing (processed) track
    this.micGain = null; // mic volume gain
    this.micAnalyser = null;
    this.selfMuted = false;
    this.selfDeafened = false;

    this.peerAudio = new Map(); // peerId -> { source, gain, muted }
    this.screenAudio = new Map(); // peerId -> { source, gain, muted }

    this.onLevel = null;
    this._meterTimer = null;
  }

  ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
      this.applyOutputVolume();
      this.applyDeafen();
      this.applySink();
      this.ctx.resume().catch(() => {});
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  async setOutputDevice(deviceId) {
    this.ensureContext();
    if (typeof this.ctx.setSinkId === 'function') {
      try {
        await this.ctx.setSinkId(deviceId || 'default');
      } catch {
        /* device may not exist yet */
      }
    }
  }

  applySink() {
    const deviceId = state.config?.speakerDeviceId || 'default';
    this.setOutputDevice(deviceId);
  }

  applyOutputVolume() {
    if (!this.masterGain || !this.ctx) return;
    const v = clamp((state.config?.outputVolume ?? 100) / 100, 0, 2);
    this.masterGain.gain.setTargetAtTime(this.selfDeafened ? 0 : v, this.ctx.currentTime, 0.02);
  }

  applyDeafen() {
    this.applyOutputVolume();
  }

  setSelfDeafened(deafened) {
    this.selfDeafened = deafened;
    this.applyDeafen();
  }

  setOutputVolume(v) {
    state.config.outputVolume = clamp(v, 0, 200);
    this.applyOutputVolume();
  }

  async startMic() {
    this.ensureContext();
    const cfg = state.config || {};
    const constraints = {
      audio: {
        deviceId: cfg.micDeviceId && cfg.micDeviceId !== 'default' ? { exact: cfg.micDeviceId } : undefined,
        echoCancellation: !!cfg.echoCancellation,
        noiseSuppression: !!cfg.noiseSuppression,
        autoGainControl: !!cfg.autoGainControl,
      },
    };
    this.micRawStream = await navigator.mediaDevices.getUserMedia(constraints);

    const source = this.ctx.createMediaStreamSource(this.micRawStream);
    this.micGain = this.ctx.createGain();
    this.micGain.gain.value = clamp((cfg.micVolume ?? 100) / 100, 0, 2);

    const destination = this.ctx.createMediaStreamDestination();
    source.connect(this.micGain);
    this.micGain.connect(destination);

    // Input level meter (parallel tap, unaffected by mic gain).
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    source.connect(this.micAnalyser);

    this.micTrack = destination.stream.getAudioTracks()[0];
    this.micTrack.enabled = !this.selfMuted;
    this.startMeterLoop();
    return this.micTrack;
  }

  stopMic() {
    this.stopMeterLoop();
    if (this.micRawStream) {
      for (const track of this.micRawStream.getTracks()) track.stop();
      this.micRawStream = null;
    }
    if (this.micTrack) {
      try {
        this.micTrack.stop();
      } catch {
        /* ignore */
      }
      this.micTrack = null;
    }
    this.micGain = null;
    this.micAnalyser = null;
  }

  setMicVolume(v) {
    state.config.micVolume = clamp(v, 0, 200);
    if (this.micGain && this.ctx) {
      this.micGain.gain.setTargetAtTime(state.config.micVolume / 100, this.ctx.currentTime, 0.02);
    }
  }

  setSelfMuted(muted) {
    this.selfMuted = muted;
    if (this.micTrack) this.micTrack.enabled = !muted;
  }

  addRemoteTrack(peerId, track) {
    this.ensureContext();
    this.removePeer(peerId);
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.masterGain);
    this.peerAudio.set(peerId, { source, gain, muted: false });
  }

  addRemoteScreenAudio(peerId, track) {
    this.ensureContext();
    this.removePeerScreenAudio(peerId);
    const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.masterGain);
    this.screenAudio.set(peerId, { source, gain, muted: false });
  }

  setPeerVolume(peerId, volume) {
    const entry = this.peerAudio.get(peerId);
    if (!entry) return;
    const v = clamp(volume, 0, 200);
    entry.gain.gain.setTargetAtTime(entry.muted ? 0 : v / 100, this.ctx.currentTime, 0.02);
    return v;
  }

  setPeerMuted(peerId, muted) {
    const entry = this.peerAudio.get(peerId);
    if (!entry) return;
    entry.muted = muted;
    entry.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  setScreenVolume(peerId, volume) {
    const entry = this.screenAudio.get(peerId);
    if (!entry) return;
    const v = clamp(volume, 0, 200);
    entry.gain.gain.setTargetAtTime(entry.muted ? 0 : v / 100, this.ctx.currentTime, 0.02);
    return v;
  }

  setScreenMuted(peerId, muted) {
    const entry = this.screenAudio.get(peerId);
    if (!entry) return;
    entry.muted = muted;
    entry.gain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  removePeer(peerId) {
    const entry = this.peerAudio.get(peerId);
    if (entry) {
      try {
        entry.source.disconnect();
        entry.gain.disconnect();
      } catch {
        /* ignore */
      }
      this.peerAudio.delete(peerId);
    }
  }

  removePeerScreenAudio(peerId) {
    const entry = this.screenAudio.get(peerId);
    if (entry) {
      try {
        entry.source.disconnect();
        entry.gain.disconnect();
      } catch {
        /* ignore */
      }
      this.screenAudio.delete(peerId);
    }
  }

  removeAll() {
    for (const id of [...this.peerAudio.keys()]) this.removePeer(id);
    for (const id of [...this.screenAudio.keys()]) this.removePeerScreenAudio(id);
  }

  getInputLevel() {
    if (!this.micAnalyser) return 0;
    const data = new Uint8Array(this.micAnalyser.fftSize);
    this.micAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  startMeterLoop() {
    this.stopMeterLoop();
    this._meterTimer = setInterval(() => {
      if (this.onLevel) this.onLevel(this.getInputLevel());
    }, 60);
  }

  stopMeterLoop() {
    if (this._meterTimer) {
      clearInterval(this._meterTimer);
      this._meterTimer = null;
    }
  }

  destroy() {
    this.stopMeterLoop();
    this.stopMic();
    this.removeAll();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
