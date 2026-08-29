// Beam file-frame chunking/assembly unit tests — plain node:assert.
//
// Verifies encode/decode round-trips, multi-file assembly, out-of-order
// assembly, empty files, and a >= 50 MB synthetic payload (in-memory).
//
// Run: node tests/transfer.test.js  (must exit 0)

import assert from 'node:assert/strict';
import {
  encodeFrame,
  decodeFrame,
  chunkFile,
  FileAssembler,
  FRAME_TYPE_DATA,
  FRAME_TYPE_END,
  DEFAULT_CHUNK_SIZE,
} from '../src/shared/transfer-frames.js';

function makePattern(size) {
  const u8 = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) u8[i] = i % 251;
  return u8;
}

function byteEqual(a, b) {
  if (a.length !== b.length) return false;
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).compare(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  ) === 0;
}

// --- single-frame encode/decode round-trip ---
{
  const payload = new Uint8Array([1, 2, 3, 250, 251]);
  const frame = encodeFrame({
    type: FRAME_TYPE_DATA,
    fileId: 42,
    seq: 7,
    totalSize: 5,
    fileName: 'a b/?.bin',
    payload,
  });
  const decoded = decodeFrame(frame);
  assert.equal(decoded.type, FRAME_TYPE_DATA);
  assert.equal(decoded.fileId, 42);
  assert.equal(decoded.seq, 7);
  assert.equal(decoded.totalSize, 5);
  assert.equal(decoded.fileName, 'a b/?.bin');
  assert.deepEqual(Array.from(decoded.payload), [1, 2, 3, 250, 251]);
  console.log('single-frame encode/decode OK');
}

// --- empty file ---
{
  const frames = [...chunkFile({ fileId: 9, fileName: 'empty.txt', data: new Uint8Array(0) })];
  assert.equal(frames.length, 1);
  const decoded = decodeFrame(frames[0]);
  assert.equal(decoded.type, FRAME_TYPE_END);
  assert.equal(decoded.seq, 0);
  assert.equal(decoded.payloadLength, 0);
  console.log('empty file -> single END frame OK');
}

// --- >= 50 MB payload round-trip ---
{
  const size = 50 * 1024 * 1024 + 12345; // just over 50 MiB
  const payload = makePattern(size);
  const frames = [...chunkFile({ fileId: 1, fileName: 'big.bin', data: payload })];
  const expectedFrames = Math.ceil(size / DEFAULT_CHUNK_SIZE);
  assert.equal(frames.length, expectedFrames, 'chunk count');

  const assembler = new FileAssembler();
  let completed = null;
  let lastSeq = -1;
  for (const frame of frames) {
    const decoded = decodeFrame(frame);
    // verify order metadata is intact
    assert.ok(decoded.seq > lastSeq, 'seq strictly increasing for in-order stream');
    lastSeq = decoded.seq;
    const res = assembler.addFrame(decoded);
    if (res) completed = res;
  }
  assert.ok(completed, 'file completed');
  assert.equal(completed.fileId, 1);
  assert.equal(completed.fileName, 'big.bin');
  assert.equal(completed.size, size);
  assert.ok(byteEqual(completed.data, payload), '50MB payload byte-identical');
  console.log(
    `50MB+ round-trip OK: ${frames.length} frames, ${completed.size} bytes`
  );
}

// --- multiple files, out-of-order data frames ---
{
  const files = [
    { fileId: 100, fileName: 'a.bin', data: makePattern(3 * DEFAULT_CHUNK_SIZE + 17) },
    { fileId: 101, fileName: 'b.bin', data: makePattern(5 * DEFAULT_CHUNK_SIZE) },
    { fileId: 102, fileName: 'c.bin', data: makePattern(1234) },
  ];

  const assembler = new FileAssembler();
  const done = new Map();

  for (const f of files) {
    const frames = [...chunkFile({ fileId: f.fileId, fileName: f.fileName, data: f.data })];
    const dataFrames = frames.slice(0, -1).map(decodeFrame);
    const endFrame = decodeFrame(frames[frames.length - 1]);

    // reverse data frames to simulate out-of-order arrival
    for (const frame of dataFrames.reverse()) {
      const res = assembler.addFrame(frame);
      if (res) done.set(res.fileId, res);
    }
    const res = assembler.addFrame(endFrame);
    if (res) done.set(res.fileId, res);
  }

  assert.equal(done.size, 3, 'three files assembled');
  for (const f of files) {
    const res = done.get(f.fileId);
    assert.ok(res, `file ${f.fileId} present`);
    assert.equal(res.size, f.data.length);
    assert.ok(byteEqual(res.data, f.data), `file ${f.fileId} byte-identical`);
  }
  console.log('multi-file out-of-order assembly OK');
}

// --- END frame arriving first, then data frames ---
{
  const data = makePattern(2 * DEFAULT_CHUNK_SIZE + 99);
  const frames = [...chunkFile({ fileId: 200, fileName: 'reversed.bin', data })].map(decodeFrame);
  const endFrame = frames[frames.length - 1];
  const dataFrames = frames.slice(0, -1);

  const assembler = new FileAssembler();
  let res = assembler.addFrame(endFrame); // END first
  assert.equal(res, null, 'not complete before data');
  for (const frame of dataFrames.reverse()) {
    res = assembler.addFrame(frame);
  }
  assert.ok(res, 'completed after data arrives');
  assert.ok(byteEqual(res.data, data));
  console.log('END-first out-of-order assembly OK');
}

// --- decode error on bad magic ---
{
  const frame = encodeFrame({ type: FRAME_TYPE_DATA, fileId: 1, seq: 0, totalSize: 1, payload: new Uint8Array([1]) });
  frame[0] = 0xff; // corrupt magic
  assert.throws(() => decodeFrame(frame), /magic/);
  console.log('bad-magic rejection OK');
}

console.log('ALL TRANSFER TESTS PASSED');
