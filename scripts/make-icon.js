// Beam icon generator — dependency-free, no network, no image libraries.
//
// Emits a single valid 256x256 32-bit ICO at build/icon.ico:
//
//   ICONDIR (6 bytes)
//   ICONDIRENTRY (16 bytes)
//   BITMAPINFOHEADER (40 bytes)
//   XOR pixel data (256*256*4 bytes, BGRA, bottom-up)
//   AND mask (256*256/8 bytes, all zero — alpha channel is authoritative)
//
// Design: dark rounded-square background (#1b222c) with a blue (#5b9dff)
// "beam" glyph — a dot plus two arcs, flat and readable at small sizes.
//
// Run:  node scripts/make-icon.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'build');
const OUT_FILE = path.join(OUT_DIR, 'icon.ico');

const SIZE = 256;
const BG = [0x1b, 0x22, 0x2c]; // #1b222c
const GLYPH = [0x5b, 0x9d, 0xff]; // #5b9dff

// Rounded-square geometry (full-bleed).
const RECT = { cx: 128, cy: 128, half: 128, radius: 56 };

// Glyph geometry: dot + two arcs, centered on the dot.
const GLYPH_CENTER = { x: 128, y: 166 };
const DOT = { x: 128, y: 166, r: 12 };
const ARCS = [
  { r: 30, thickness: 14, a0: 200, a1: 340 },
  { r: 60, thickness: 14, a0: 200, a1: 340 },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Signed distance to a rounded rectangle (negative inside).
function roundedRectSDF(px, py, { cx, cy, half, radius }) {
  const qx = Math.abs(px - cx) - (half - radius);
  const qy = Math.abs(py - cy) - (half - radius);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Coverage (0..1) from a signed distance, ~0.5px anti-aliased edge.
function edge(d) {
  return clamp(0.5 - d, 0, 1);
}

function circleCoverage(px, py, { x, y, r }) {
  return edge(Math.hypot(px - x, py - y) - r);
}

function arcCoverage(px, py, { r, thickness, a0, a1 }) {
  const dx = px - GLYPH_CENTER.x;
  const dy = py - GLYPH_CENTER.y;
  const dist = Math.hypot(dx, dy);

  // Radial: distance from the ring.
  const radial = edge(Math.abs(dist - r) - thickness / 2);
  if (radial <= 0) return 0;

  // Angular: distance (in pixels along the arc) to the [a0, a1] span.
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  let angDist = 0;
  if (ang < a0 || ang > a1) {
    angDist = Math.min(
      Math.abs(ang - a0),
      Math.abs(ang - a1),
      Math.abs(ang - a0 - 360),
      Math.abs(ang - a0 + 360),
      Math.abs(ang - a1 - 360),
      Math.abs(ang - a1 + 360)
    );
  }
  const angPx = (angDist * Math.PI) / 180 * r;
  return radial * edge(angPx);
}

function pixel(px, py) {
  const bgA = edge(roundedRectSDF(px, py, RECT));

  const glyph = clamp(
    Math.max(
      circleCoverage(px, py, DOT),
      arcCoverage(px, py, ARCS[0]),
      arcCoverage(px, py, ARCS[1])
    ),
    0,
    1
  );

  const r = Math.round(lerp(BG[0], GLYPH[0], glyph));
  const g = Math.round(lerp(BG[1], GLYPH[1], glyph));
  const b = Math.round(lerp(BG[2], GLYPH[2], glyph));
  const a = Math.round(bgA * 255);
  return [b, g, r, a]; // BGRA
}

function buildIco() {
  const xorBytes = SIZE * SIZE * 4;
  const andBytes = (SIZE * SIZE) / 8;
  const imageBytes = 40 + xorBytes + andBytes; // BITMAPINFOHEADER + XOR + AND
  const offset = 6 + 16; // ICONDIR + ICONDIRENTRY

  const header = Buffer.alloc(offset);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  // ICONDIRENTRY (starts at offset 6)
  header.writeUInt8(0, 6); // width: 0 == 256
  header.writeUInt8(0, 7); // height: 0 == 256
  header.writeUInt8(0, 8); // color count
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bit count
  header.writeUInt32LE(imageBytes, 14); // bytes in resource
  header.writeUInt32LE(offset, 18); // image data offset

  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0); // biSize
  bih.writeInt32LE(SIZE, 4); // biWidth
  bih.writeInt32LE(SIZE * 2, 8); // biHeight (XOR + AND)
  bih.writeUInt16LE(1, 12); // biPlanes
  bih.writeUInt16LE(32, 14); // biBitCount
  bih.writeUInt32LE(0, 16); // biCompression (BI_RGB)
  bih.writeUInt32LE(xorBytes + andBytes, 20); // biSizeImage
  bih.writeInt32LE(0, 24); // biXPelsPerMeter
  bih.writeInt32LE(0, 28); // biYPelsPerMeter
  bih.writeUInt32LE(0, 32); // biClrUsed
  bih.writeUInt32LE(0, 36); // biClrImportant

  const xor = Buffer.alloc(xorBytes);
  for (let y = 0; y < SIZE; y += 1) {
    // ICO pixel rows are bottom-up: row 0 is the bottom of the image.
    const row = SIZE - 1 - y;
    for (let x = 0; x < SIZE; x += 1) {
      const [b, g, r, a] = pixel(x + 0.5, y + 0.5);
      const i = (row * SIZE + x) * 4;
      xor[i] = b;
      xor[i + 1] = g;
      xor[i + 2] = r;
      xor[i + 3] = a;
    }
  }

  const and = Buffer.alloc(andBytes); // all zero: 32-bit alpha controls transparency

  return Buffer.concat([header, bih, xor, and]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const ico = buildIco();
fs.writeFileSync(OUT_FILE, ico);

// Self-check: read back the header and report.
const check = Buffer.from(fs.readFileSync(OUT_FILE));
const count = check.readUInt16LE(4);
const w = check.readUInt8(6) || 256;
const h = check.readUInt8(7) || 256;
const bpp = check.readUInt16LE(12);
const size = check.readUInt32LE(14);
const dataOffset = check.readUInt32LE(18);

console.log(`wrote ${OUT_FILE}`);
console.log(
  `  images=${count} size=${w}x${h} bpp=${bpp} imageBytes=${size} offset=${dataOffset} fileBytes=${check.length}`
);

if (count !== 1 || w !== 256 || h !== 256 || bpp !== 32 || dataOffset !== 22) {
  console.error('ICO self-check FAILED');
  process.exit(1);
}
console.log('ICO self-check OK');
