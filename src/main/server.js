// Beam room server — standalone module (no Electron imports).
//
// Runs inside the HOST's Electron main process, but is written as a plain
// Node ES module so tests can spawn it directly with `ws` and node:http.
//
// Responsibilities:
//   * tiny HTTP `GET /info` endpoint (app/version/room name/hasPassword/roomCodeRequired)
//   * WebSocket signaling relay (offer / answer / ICE between peer ids)
//   * roster management + owner auth (owner token generated at room creation)
//   * join auth (room code + optional password via node:crypto scrypt)
//   * owner commands (kick / mute-for-everyone / deafen / undeafen)
//   * member cap
//   * anti-brute-force (generic errors, per-IP counters, exponential delay, lockout)

import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Crockford base32 alphabet: avoids visually ambiguous I, L, O, U.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const DEFAULT_BRUTE_FORCE = {
  // After this many consecutive failures, start imposing a delay before the
  // next attempt. Delay is delayBaseMs * 2^(failures - delayAfterFailures),
  // capped at delayCapMs.
  delayAfterFailures: 3,
  delayBaseMs: 1000,
  delayCapMs: 60000,
  // Lock an IP out for lockDurationMs after lockThreshold failures within
  // lockWindowMs.
  lockThreshold: 8,
  lockWindowMs: 10 * 60 * 1000,
  lockDurationMs: 10 * 60 * 1000,
};

const MAX_NAME_LENGTH = 40;
const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MiB per signaling/control message

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateRoomCode(length = 8) {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

function safeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Anonymous';
  // Strip control chars and trim, enforce length.
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return 'Anonymous';
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

function sanitizeBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function getRemoteIp(ws) {
  const socket = ws && ws._socket;
  if (socket && socket.remoteAddress) return socket.remoteAddress;
  return 'unknown';
}

/**
 * Create and start a room server.
 *
 * @param {object} [options]
 * @param {number} [options.port=0]  TCP port (0 = ephemeral, returned via `.port`)
 * @param {string} [options.roomName='Beam Room']
 * @param {string} [options.password]  optional room password (scrypt-hashed)
 * @param {number} [options.memberCap=16]
 * @param {object} [options.bruteForce]  override anti-brute-force settings (tests)
 * @param {Function} [options.log]  logger, defaults to console.log
 * @param {string} [options.version='1.0.0']  app version surfaced in /info
 * @param {string} [options.app='Beam']
 * @returns {Promise<object>} server handle
 */
export async function createRoom(options = {}) {
  const {
    port = 0,
    roomName = 'Beam Room',
    password,
    memberCap = 16,
    bruteForce: bruteForceOverride = {},
    log = (...args) => console.log(...args),
    version = '1.0.0',
    app = 'Beam',
  } = options;

  const bruteForce = { ...DEFAULT_BRUTE_FORCE, ...bruteForceOverride };

  const roomCode = generateRoomCode();
  const ownerToken = generateToken();
  const hasPassword = typeof password === 'string' && password.length > 0;

  let passwordRecord = null;
  if (hasPassword) {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64);
    passwordRecord = { salt: salt.toString('hex'), hash: hash.toString('hex') };
  }

  // member id -> member record
  const members = new Map();
  // member id -> ws socket
  const sockets = new Map();
  // ip -> brute-force record
  const bruteState = new Map();

  let nextMemberId = 1;

  function newMemberId() {
    const id = `peer-${nextMemberId}`;
    nextMemberId += 1;
    return id;
  }

  function rosterPayload() {
    return Array.from(members.values()).map((m) => ({ ...m }));
  }

  function broadcastRoster() {
    const payload = JSON.stringify({ type: 'roster', members: rosterPayload() });
    for (const ws of sockets.values()) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  function send(ws, obj) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function closeWith(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
  }

  function logAuthFailure(ip) {
    log(`[beam][auth-fail] ${new Date().toISOString()} ip=${ip}`);
  }

  function bruteIsLocked(ip) {
    const rec = bruteState.get(ip);
    if (!rec) return false;
    return rec.lockUntil > Date.now();
  }

  function bruteDelayMs(ip) {
    const rec = bruteState.get(ip);
    if (!rec) return 0;
    const failures = rec.consecutive;
    if (failures < bruteForce.delayAfterFailures) return 0;
    const exponent = failures - bruteForce.delayAfterFailures;
    return Math.min(bruteForce.delayCapMs, bruteForce.delayBaseMs * 2 ** exponent);
  }

  function bruteRecordFailure(ip) {
    const now = Date.now();
    let rec = bruteState.get(ip);
    if (!rec) rec = { failures: [], consecutive: 0, lockUntil: 0 };
    rec.failures.push(now);
    rec.failures = rec.failures.filter((t) => now - t <= bruteForce.lockWindowMs);
    rec.consecutive += 1;
    if (rec.failures.length >= bruteForce.lockThreshold) {
      rec.lockUntil = now + bruteForce.lockDurationMs;
    }
    bruteState.set(ip, rec);
  }

  function bruteRecordSuccess(ip) {
    bruteState.set(ip, { failures: [], consecutive: 0, lockUntil: 0 });
  }

  async function authenticate(msg, ip) {
    if (typeof msg.roomCode !== 'string' || msg.roomCode !== roomCode) {
      return { ok: false };
    }
    // Owner token grants owner status (and bypasses the password the owner set).
    if (typeof msg.ownerToken === 'string' && msg.ownerToken.length > 0) {
      if (safeEqualHex(msg.ownerToken, ownerToken)) {
        return { ok: true, isOwner: true };
      }
      // Wrong owner token treated as a normal failed password attempt.
    }
    if (hasPassword) {
      if (typeof msg.password !== 'string') return { ok: false };
      const candidate = await scryptAsync(msg.password, Buffer.from(passwordRecord.salt, 'hex'), 64);
      if (!safeEqualHex(candidate.toString('hex'), passwordRecord.hash)) {
        return { ok: false };
      }
    }
    return { ok: true, isOwner: false };
  }

  function handleOwnerCommand(ws, msg, memberId) {
    const member = members.get(memberId);
    if (!member || !member.isOwner) {
      send(ws, { type: 'error', code: 'forbidden', message: 'Not allowed' });
      return;
    }
    if (typeof msg.token !== 'string' || !safeEqualHex(msg.token, ownerToken)) {
      send(ws, { type: 'error', code: 'forbidden', message: 'Not allowed' });
      return;
    }

    const target = members.get(msg.target);
    if (!target) return;

    switch (msg.command) {
      case 'kick': {
        const targetWs = sockets.get(target.id);
        send(targetWs, { type: 'kicked', reason: 'Kicked by the room owner' });
        closeWith(targetWs, 4001, 'kicked');
        break;
      }
      case 'mute-for-everyone': {
        target.muted = true;
        send(sockets.get(target.id), { type: 'forced-state', muted: true });
        broadcastRoster();
        break;
      }
      case 'unmute-for-everyone': {
        target.muted = false;
        send(sockets.get(target.id), { type: 'forced-state', muted: false });
        broadcastRoster();
        break;
      }
      case 'deafen': {
        target.deafened = true;
        send(sockets.get(target.id), { type: 'forced-state', deafened: true });
        broadcastRoster();
        break;
      }
      case 'undeafen': {
        target.deafened = false;
        send(sockets.get(target.id), { type: 'forced-state', deafened: false });
        broadcastRoster();
        break;
      }
      default:
        break;
    }
  }

  async function handleJoin(ws, msg, ip) {
    // Locked out — fail fast, still generic.
    if (bruteIsLocked(ip)) {
      logAuthFailure(ip);
      send(ws, { type: 'error', code: 'auth_failed', message: 'Authentication failed' });
      closeWith(ws, 4003, 'auth_failed');
      return;
    }

    const delay = bruteDelayMs(ip);
    if (delay > 0) await sleep(delay);

    if (members.size >= memberCap) {
      // Room full is not an auth failure; it is not a secret.
      send(ws, { type: 'error', code: 'room_full', message: 'Room is full' });
      closeWith(ws, 4004, 'room_full');
      return;
    }

    const result = await authenticate(msg, ip);
    if (!result.ok) {
      bruteRecordFailure(ip);
      logAuthFailure(ip);
      send(ws, { type: 'error', code: 'auth_failed', message: 'Authentication failed' });
      closeWith(ws, 4003, 'auth_failed');
      return;
    }

    bruteRecordSuccess(ip);

    const id = newMemberId();
    const member = {
      id,
      name: sanitizeName(msg.name),
      isOwner: result.isOwner,
      inVC: false,
      streaming: false,
      deafened: false,
      muted: false,
    };
    members.set(id, member);
    sockets.set(id, ws);

    send(ws, {
      type: 'welcome',
      selfId: id,
      roomName,
      roomCode,
      youAreOwner: member.isOwner,
      ownerId: Array.from(members.values()).find((m) => m.isOwner)?.id || null,
      members: rosterPayload(),
    });

    broadcastRoster();
  }

  function handleMessage(ws, raw, ip) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      send(ws, { type: 'error', code: 'bad_message', message: 'Bad message' });
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // 'join' is handled before sender lookup: the sender is not a member yet.
    if (msg.type === 'join') {
      handleJoin(ws, msg, ip);
      return;
    }

    // Identify the sender by scanning sockets.
    let senderId = null;
    for (const [id, socket] of sockets.entries()) {
      if (socket === ws) {
        senderId = id;
        break;
      }
    }
    if (!senderId) return;

    switch (msg.type) {
      case 'signal': {
        const targetWs = sockets.get(msg.to);
        if (targetWs && targetWs.readyState === targetWs.OPEN) {
          send(targetWs, { type: 'signal', from: senderId, data: msg.data });
        }
        break;
      }
      case 'owner-command': {
        handleOwnerCommand(ws, msg, senderId);
        break;
      }
      case 'state': {
        const member = members.get(senderId);
        if (!member) break;
        if ('inVC' in msg) member.inVC = sanitizeBool(msg.inVC, member.inVC);
        if ('streaming' in msg) member.streaming = sanitizeBool(msg.streaming, member.streaming);
        if ('deafened' in msg) member.deafened = sanitizeBool(msg.deafened, member.deafened);
        if ('muted' in msg) member.muted = sanitizeBool(msg.muted, member.muted);
        if ('name' in msg) member.name = sanitizeName(msg.name);
        broadcastRoster();
        break;
      }
      default:
        break;
    }
  }

  function handleClose(ws) {
    let removedId = null;
    for (const [id, socket] of sockets.entries()) {
      if (socket === ws) {
        removedId = id;
        break;
      }
    }
    if (removedId) {
      members.delete(removedId);
      sockets.delete(removedId);
      broadcastRoster();
    }
  }

  const httpServer = createHttpServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method === 'GET' && (req.url === '/info' || req.url?.startsWith('/info?'))) {
      res.writeHead(200, cors);
      res.end(
        JSON.stringify({
          app,
          version,
          roomName,
          hasPassword,
          roomCodeRequired: true,
        })
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  const wsServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

  wsServer.on('connection', (ws) => {
    const ip = getRemoteIp(ws);
    ws.on('message', (raw) => handleMessage(ws, raw, ip));
    ws.on('close', () => handleClose(ws));
    ws.on('error', () => {
      /* handled via close */
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const actualPort = httpServer.address().port;

  function close() {
    return new Promise((resolve) => {
      for (const ws of sockets.values()) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      members.clear();
      wsServer.close();
      httpServer.close(() => resolve());
    });
  }

  return {
    httpServer,
    wsServer,
    port: actualPort,
    roomCode,
    ownerToken,
    roomName,
    hasPassword,
    memberCap,
    info: { app, version, roomName, hasPassword, roomCodeRequired: true },
    close,
    // Test/ops helper: clear per-IP brute-force state.
    resetBruteForce() {
      bruteState.clear();
    },
  };
}

export { generateRoomCode, CODE_ALPHABET, DEFAULT_BRUTE_FORCE };
