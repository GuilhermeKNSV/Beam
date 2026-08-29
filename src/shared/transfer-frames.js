// Beam file-transfer frame codec — pure logic, no DOM / Electron imports.
//
// Used by the renderer (over WebRTC data channels) and by unit tests.
//
// A file is split into fixed-size payload chunks. Each chunk is encoded as a
// self-describing binary frame so the receiver can reassemble (even slightly
// out of order) without holding the whole file in memory at once.
//
// Frame layout (big-endian, header = 28 bytes + UTF-8 file name):
//   offset  0   magic        4 bytes  ASCII "BTF1"
//   offset  4   version      1 byte   = 1
//   offset  5   type         1 byte   1 = data chunk, 2 = end (final chunk)
//   offset  6   fileId       4 bytes  uint32
//   offset 10   seq          4 bytes  uint32 (0-based chunk index)
//   offset 14   payloadLen   4 bytes  uint32
//   offset 18   totalSize    8 bytes  uint64 (total file size)
//   offset 26   nameLen      2 bytes  uint16
//   offset 28   fileName     nameLen bytes UTF-8
//   offset ...  payload      payloadLen bytes

const MAGIC = new Uint8Array([0x42, 0x54, 0x46, 0x31]); // "BTF1"
const HEADER_FIXED = 28;

export const FRAME_TYPE_DATA = 1;
export const FRAME_TYPE_END = 2;
export const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFrame({ type, fileId, seq, totalSize, fileName = '', payload = new Uint8Array(0) }) {
  const nameBytes = textEncoder.encode(fileName);
  const payloadBytes =
    payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(HEADER_FIXED + nameBytes.length + payloadBytes.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  out.set(MAGIC, 0);
  view.setUint8(4, 1); // version
  view.setUint8(5, type);
  view.setUint32(6, fileId >>> 0);
  view.setUint32(10, seq >>> 0);
  view.setUint32(14, payloadBytes.length);
  view.setBigUint64(18, BigInt(totalSize));
  view.setUint16(26, nameBytes.length);
  out.set(nameBytes, HEADER_FIXED);
  out.set(payloadBytes, HEADER_FIXED + nameBytes.length);
  return out;
}

export function decodeFrame(frame) {
  if (!(frame instanceof Uint8Array)) {
    throw new Error('decodeFrame expects a Uint8Array');
  }
  if (frame.byteLength < HEADER_FIXED) {
    throw new Error('frame too short');
  }
  for (let i = 0; i < 4; i += 1) {
    if (frame[i] !== MAGIC[i]) throw new Error('bad frame magic');
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = view.getUint8(4);
  if (version !== 1) throw new Error(`unsupported frame version ${version}`);
  const type = view.getUint8(5);
  const fileId = view.getUint32(6);
  const seq = view.getUint32(10);
  const payloadLength = view.getUint32(14);
  const totalSize = Number(view.getBigUint64(18));
  const nameLength = view.getUint16(26);
  const fileName = textDecoder.decode(
    new Uint8Array(frame.buffer, frame.byteOffset + HEADER_FIXED, nameLength)
  );
  const payloadStart = HEADER_FIXED + nameLength;
  if (frame.byteLength < payloadStart + payloadLength) {
    throw new Error('frame payload truncated');
  }
  const payload = new Uint8Array(
    frame.buffer,
    frame.byteOffset + payloadStart,
    payloadLength
  );
  return { type, fileId, seq, payloadLength, totalSize, fileName, payload };
}

/**
 * Split a whole Uint8Array into frames. The renderer streams file slices
 * through this same encoder one chunk at a time; this generator is the
 * in-memory convenience used by tests.
 */
export function* chunkFile({
  fileId,
  fileName = '',
  data,
  chunkSize = DEFAULT_CHUNK_SIZE,
}) {
  const total = data.length;
  const totalChunks = total === 0 ? 1 : Math.ceil(total / chunkSize);
  for (let seq = 0; seq < totalChunks; seq += 1) {
    const start = seq * chunkSize;
    const end = Math.min(total, start + chunkSize);
    const payload = data.subarray(start, end);
    const isLast = seq === totalChunks - 1;
    yield encodeFrame({
      type: isLast ? FRAME_TYPE_END : FRAME_TYPE_DATA,
      fileId,
      seq,
      totalSize: total,
      fileName,
      payload,
    });
  }
}

/**
 * Incremental reassembly of one or more files (keyed by fileId) from a stream
 * of frames. Returns a completed file object when the END frame is seen and
 * every chunk is present, otherwise null.
 */
export class FileAssembler {
  constructor() {
    this.files = new Map();
  }

  addFrame(frame) {
    let entry = this.files.get(frame.fileId);
    if (!entry) {
      entry = {
        chunks: new Map(),
        totalSize: null,
        totalChunks: null,
        fileName: '',
        receivedBytes: 0,
        done: false,
      };
      this.files.set(frame.fileId, entry);
    }
    if (frame.fileName) entry.fileName = frame.fileName;
    if (typeof frame.totalSize === 'number') entry.totalSize = frame.totalSize;

    if (!entry.chunks.has(frame.seq)) {
      const copy = new Uint8Array(frame.payload); // detach from any shared buffer
      entry.chunks.set(frame.seq, copy);
      entry.receivedBytes += copy.length;
    }

    if (frame.type === FRAME_TYPE_END) {
      entry.totalChunks = frame.seq + 1;
    }

    if (entry.totalChunks != null && entry.chunks.size >= entry.totalChunks) {
      return this._assemble(entry, frame.fileId);
    }
    return null;
  }

  _assemble(entry, fileId) {
    const parts = [];
    let sum = 0;
    for (let seq = 0; seq < entry.totalChunks; seq += 1) {
      const chunk = entry.chunks.get(seq);
      if (!chunk) return null; // not fully received yet
      parts.push(chunk);
      sum += chunk.length;
    }
    if (entry.totalSize != null && sum !== entry.totalSize) {
      throw new Error(
        `file ${fileId} size mismatch: expected ${entry.totalSize}, received ${sum}`
      );
    }
    const out = new Uint8Array(entry.totalSize != null ? entry.totalSize : sum);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    entry.done = true;
    return { fileId, fileName: entry.fileName, size: out.length, data: out };
  }

  get size() {
    return this.files.size;
  }
}

export function assembleFrames(frames) {
  const assembler = new FileAssembler();
  const results = [];
  for (const frame of frames) {
    const completed = assembler.addFrame(decodeFrame(frame));
    if (completed) results.push(completed);
  }
  return results;
}
