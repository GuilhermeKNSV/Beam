// Beam file transfer — roster-driven request/accept, bidirectional transfer
// over WebRTC data channels, streaming chunk send (never holds a whole large
// file in JS heap), and FS Access / <a download> receive.

import { state } from './state.js';
import { $, el, clear, toast, uid, formatBytes, formatSpeed, formatEta, downloadBlob, clamp } from './util.js';
import {
  encodeFrame,
  decodeFrame,
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  DEFAULT_CHUNK_SIZE,
} from '../shared/transfer-frames.js';

function peerName(peerId) {
  return state.roster.get(peerId)?.name || peerId;
}

function ensureOpen(channel) {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.addEventListener('open', () => resolve(), { once: true });
    channel.addEventListener('close', () => reject(new Error('channel closed')), { once: true });
    channel.addEventListener('error', () => reject(new Error('channel error')), { once: true });
  });
}

function waitForBuffer(channel, threshold = 1024 * 1024) {
  if (!channel || channel.bufferedAmount < threshold) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, 8000);
    function finish() {
      clearTimeout(timer);
      channel.removeEventListener('bufferedamountlow', onLow);
      resolve();
    }
    function onLow() {
      finish();
    }
    channel.bufferedAmountLowThreshold = threshold;
    channel.addEventListener('bufferedamountlow', onLow);
  });
}

class TransferSession {
  constructor(sessionId, peerId, isRequester) {
    this.sessionId = sessionId;
    this.peerId = peerId;
    this.isRequester = isRequester;
    this.accepted = false;
    this.declined = false;
    this.channel = null;
    this.files = [];
    this.selfConfirmed = false;
    this.peerConfirmed = false;
    this.started = false;
    this.sending = new Map();
    this.receiving = new Map();
    this.recvChain = Promise.resolve();
    this.dirHandle = null;
    this.cancelled = false;
    this.el = null;
  }

  status() {
    if (this.declined) return 'Declined';
    if (!this.isRequester && !this.accepted) return 'Awaiting your response';
    if (this.isRequester && !this.accepted) return 'Waiting for them to accept';
    if (!this.selfConfirmed || !this.peerConfirmed) return 'Waiting for both sides to confirm';
    if (this.started) return 'Transferring…';
    return 'Ready';
  }

  attachChannel(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') return;
      let frame;
      try {
        frame = decodeFrame(new Uint8Array(event.data));
      } catch {
        return;
      }
      this.recvChain = this.recvChain.then(() => this.handleFrame(frame));
    };
    channel.onclose = () => {
      if (!this.cancelled) toast('Transfer channel closed', 'info');
    };
  }

  async handleFrame(frame) {
    let rec = this.receiving.get(frame.fileId);
    if (!rec) {
      rec = {
        fileId: frame.fileId,
        fileName: frame.fileName,
        total: frame.totalSize,
        received: 0,
        parts: [],
        writer: null,
        fileHandle: null,
        done: false,
        startTime: Date.now(),
        el: null,
      };
      this.receiving.set(frame.fileId, rec);
      if (this.dirHandle) {
        try {
          rec.fileHandle = await this.dirHandle.getFileHandle(frame.fileName, { create: true });
          rec.writer = await rec.fileHandle.createWritable();
        } catch {
          rec.fileHandle = null;
          rec.writer = null;
        }
      }
    }

    const payload = frame.payload;
    if (rec.writer) await rec.writer.write(payload);
    else rec.parts.push(payload);
    rec.received += payload.length;

    const needRender = frame.type === FRAME_TYPE_END || !rec.el;
    this.updateProgress();
    if (needRender) this.render();

    if (frame.type === FRAME_TYPE_END) {
      if (rec.writer) {
        await rec.writer.close();
      } else {
        downloadBlob(new Blob(rec.parts, { type: 'application/octet-stream' }), rec.fileName);
      }
      rec.done = true;
      toast(`Received ${rec.fileName} (${formatBytes(rec.received)})`, 'success');
      this.render();
    }
  }

  async sendFile(file) {
    const fileId = state.nextFileId++;
    const total = file.size;
    const totalChunks = total === 0 ? 1 : Math.ceil(total / DEFAULT_CHUNK_SIZE);
    const sendState = {
      fileId,
      fileName: file.name,
      total,
      sent: 0,
      done: false,
      startTime: Date.now(),
      el: null,
    };
    this.sending.set(fileId, sendState);
    this.render();

    let offset = 0;
    let seq = 0;
    while (seq < totalChunks && !this.cancelled && this.channel?.readyState === 'open') {
      const end = Math.min(offset + DEFAULT_CHUNK_SIZE, total);
      const buf = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      const frame = encodeFrame({
        type: seq === totalChunks - 1 ? FRAME_TYPE_END : FRAME_TYPE_DATA,
        fileId,
        seq,
        totalSize: total,
        fileName: file.name,
        payload: buf,
      });
      await waitForBuffer(this.channel);
      this.channel.send(frame);
      offset = end;
      seq += 1;
      sendState.sent = end;
      this.updateProgress();
    }
    sendState.done = seq === totalChunks;
    if (sendState.done) toast(`Sent ${file.name} (${formatBytes(total)})`, 'success');
    this.render();
  }

  async startTransfers() {
    try {
      await ensureOpen(this.channel);
    } catch {
      toast('Transfer channel could not open', 'error');
      return;
    }
    for (const file of this.files) {
      if (this.cancelled) break;
      await this.sendFile(file);
    }
  }

  checkStart() {
    if (this.selfConfirmed && this.peerConfirmed && !this.started && !this.cancelled) {
      this.started = true;
      this.startTransfers();
    }
    this.render();
  }

  cancel() {
    this.cancelled = true;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    this.render();
  }

  updateProgress() {
    // Refresh progress bars in place without a full rebuild.
    for (const rec of this.receiving.values()) {
      if (!rec.el) continue;
      const pct = rec.total ? clamp((rec.received / rec.total) * 100, 0, 100) : 0;
      rec.el.fill.style.width = `${pct}%`;
      rec.el.text.textContent = `↓ ${rec.fileName} ${formatBytes(rec.received)} / ${formatBytes(rec.total)}`;
    }
    for (const s of this.sending.values()) {
      if (!s.el) continue;
      const pct = s.total ? clamp((s.sent / s.total) * 100, 0, 100) : 0;
      s.el.fill.style.width = `${pct}%`;
      const elapsed = (Date.now() - s.startTime) / 1000;
      const speed = elapsed > 0 ? s.sent / elapsed : 0;
      const remaining = speed > 0 ? (s.total - s.sent) / speed : 0;
      s.el.text.textContent = `↑ ${s.fileName} ${formatBytes(s.sent)} / ${formatBytes(s.total)} · ${formatSpeed(speed)} · ${formatEta(remaining)}`;
    }
  }

  render() {
    if (!this.el) {
      this.el = el('div', { class: 'transfer-card' });
      const slot = document.getElementById('transfer-list');
      if (slot) slot.append(this.el);
    }
    const root = this.el;
    clear(root);

    const header = el(
      'div',
      { class: 'transfer-header' },
      el('span', { class: 'transfer-peer' }, this.isRequester ? `↔ ${peerName(this.peerId)}` : `↔ ${peerName(this.peerId)}`),
      el('span', { class: 'transfer-status' }, this.status())
    );
    root.append(header);

    if (!this.isRequester && !this.accepted && !this.declined) {
      root.append(
        el('div', { class: 'transfer-actions' },
          el('button', { class: 'btn primary', onclick: () => this.accept() }, 'Accept'),
          el('button', { class: 'btn danger', onclick: () => this.decline() }, 'Decline'))
      );
      return;
    }

    if (this.declined) {
      root.append(el('p', { class: 'hint' }, 'This request was declined.'));
      return;
    }

    const fileList = el('div', { class: 'transfer-files' });
    if (this.files.length) {
      for (const f of this.files) {
        fileList.append(el('div', { class: 'transfer-file' }, el('span', {}, f.name), el('span', { class: 'muted' }, formatBytes(f.size))));
      }
    } else {
      fileList.append(el('p', { class: 'hint' }, 'No files selected.'));
    }
    root.append(fileList);

    const progressArea = el('div', { class: 'transfer-progress' });
    for (const s of this.sending.values()) {
      if (!s.el) {
        s.el = { fill: el('div', { class: 'progress-fill' }), text: el('div', { class: 'progress-text' }) };
      }
      progressArea.append(el('div', { class: 'progress-row' }, s.el.text, el('div', { class: 'progress-bar' }, s.el.fill)));
    }
    for (const rec of this.receiving.values()) {
      if (!rec.el) {
        rec.el = { fill: el('div', { class: 'progress-fill' }), text: el('div', { class: 'progress-text' }) };
      }
      progressArea.append(el('div', { class: 'progress-row' }, rec.el.text, el('div', { class: 'progress-bar' }, rec.el.fill)));
    }
    root.append(progressArea);

    if (!this.started) {
      root.append(
        el('div', { class: 'transfer-actions' },
          el('button', { class: 'btn', onclick: () => this.addFiles() }, 'Add files'),
          el('button', {
            class: 'btn primary',
            disabled: this.files.length === 0,
            onclick: () => this.confirm(),
          }, this.selfConfirmed ? 'Confirmed ✓' : 'Confirm'),
          el('button', { class: 'btn danger', onclick: () => this.cancelTransfer() }, 'Cancel'))
      );
    } else {
      root.append(
        el('div', { class: 'transfer-actions' },
          el('button', { class: 'btn danger', onclick: () => this.cancelTransfer() }, 'Cancel'))
      );
    }

    this.updateProgress();
  }

  accept() {
    this.accepted = true;
    state.mesh.sendControl(this.peerId, { type: 'file-request-accept', sessionId: this.sessionId });
    this.render();
  }

  decline() {
    this.declined = true;
    state.mesh.sendControl(this.peerId, { type: 'file-request-decline', sessionId: this.sessionId });
    this.render();
  }

  async addFiles() {
    // Try to pick a save directory once per session (FS Access API).
    if (!this.dirHandle && typeof window.showDirectoryPicker === 'function') {
      try {
        this.dirHandle = await window.showDirectoryPicker();
        toast('Saving incoming files to the chosen folder', 'info');
      } catch {
        this.dirHandle = null; // fall back to <a download>
      }
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      this.files.push(...Array.from(input.files || []));
      this.render();
    };
    input.click();
  }

  confirm() {
    if (!this.files.length) {
      toast('Pick at least one file', 'error');
      return;
    }
    this.selfConfirmed = true;
    state.mesh.sendControl(this.peerId, { type: 'transfer-confirm', sessionId: this.sessionId });
    this.checkStart();
  }

  cancelTransfer() {
    this.cancel();
    state.mesh.sendControl(this.peerId, { type: 'transfer-cancel', sessionId: this.sessionId });
  }
}

export function requestFiles(peerId) {
  const sessionId = uid('transfer');
  const session = new TransferSession(sessionId, peerId, true);
  state.transfers.set(sessionId, session);
  state.mesh.sendControl(peerId, { type: 'file-request', sessionId });
  renderFilesPanel();
  toast(`File request sent to ${peerName(peerId)}`, 'info');
}

export function handleControl(peerId, msg) {
  switch (msg?.type) {
    case 'file-request': {
      const session = new TransferSession(msg.sessionId, peerId, false);
      state.transfers.set(msg.sessionId, session);
      renderFilesPanel();
      toast(`${peerName(peerId)} wants to exchange files`, 'info');
      break;
    }
    case 'file-request-accept': {
      const session = state.transfers.get(msg.sessionId);
      if (session) {
        session.accepted = true;
        const channel = state.mesh.createTransferChannel(peerId, `transfer-${msg.sessionId}`);
        session.attachChannel(channel);
        session.render();
      }
      break;
    }
    case 'file-request-decline': {
      const session = state.transfers.get(msg.sessionId);
      if (session) {
        session.declined = true;
        session.render();
        toast('File request declined', 'info');
      }
      break;
    }
    case 'transfer-confirm': {
      const session = state.transfers.get(msg.sessionId);
      if (session) {
        session.peerConfirmed = true;
        session.checkStart();
      }
      break;
    }
    case 'transfer-cancel': {
      const session = state.transfers.get(msg.sessionId);
      if (session) session.cancel();
      break;
    }
    default:
      break;
  }
}

export function handleDataChannel(peerId, channel) {
  const label = String(channel.label || '');
  const sessionId = label.replace(/^transfer-/, '');
  const session = state.transfers.get(sessionId);
  if (session && session.peerId === peerId) {
    session.attachChannel(channel);
  }
}

export function renderFilesPanel() {
  const panel = $('#panel-files');
  if (!panel) return;
  clear(panel);
  panel.append(el('h3', {}, 'Files'));
  panel.append(
    el('p', { class: 'hint' }, 'Click a person in the roster and choose "Request files" to start an exchange. Files transfer in both directions simultaneously.')
  );
  const list = el('div', { id: 'transfer-list', class: 'transfer-list' });
  panel.append(list);
  if (!state.transfers.size) {
    list.append(el('div', { class: 'empty' }, 'No active transfers.'));
  }
  for (const session of state.transfers.values()) {
    session.el = null; // force re-attach to the fresh list
    session.render();
  }
}

export function refresh() {
  renderFilesPanel();
}
