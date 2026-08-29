// Beam room-server tests — plain node:assert, no test framework.
//
// Spawns the standalone server module on an ephemeral port and asserts:
//   room create, /info shape, wrong room code rejected, wrong password
//   rejected (generic), correct join, roster broadcast, owner kick, and
//   brute-force lockout (with a short override config).
//
// Run: node tests/server.test.js  (must exit 0)

import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createRoom } from '../src/main/server.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeClient(ws) {
  const client = {
    ws,
    messages: [],
    waiters: [],
    closed: false,
    closeCode: null,
    closeReason: null,
    closePromise: null,
  };
  let resolveClose;
  client.closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });
  client._resolveClose = resolveClose;
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    client.messages.push(msg);
    for (let i = client.waiters.length - 1; i >= 0; i -= 1) {
      const w = client.waiters[i];
      if (w.predicate(msg)) {
        clearTimeout(w.timer);
        client.waiters.splice(i, 1);
        w.resolve(msg);
      }
    }
  });
  ws.on('close', (code, reason) => {
    client.closed = true;
    client.closeCode = code;
    client.closeReason = String(reason || '');
    for (const w of client.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error(`socket closed (${code}) while waiting`));
    }
    client.waiters = [];
    client._resolveClose();
  });
  ws.on('error', () => {});
  return client;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(makeClient(ws)));
    ws.on('error', reject);
  });
}

function next(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = client.waiters.findIndex((w) => w.timer === timer);
      if (i >= 0) client.waiters.splice(i, 1);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    client.waiters.push({ predicate, resolve, reject, timer });
  });
}

function send(client, obj) {
  client.ws.send(JSON.stringify(obj));
}

async function join(client, payload, timeoutMs = 5000) {
  send(client, { type: 'join', ...payload });
  const msg = await next(
    client,
    (m) => m.type === 'welcome' || m.type === 'error',
    timeoutMs
  );
  return msg;
}

const logs = [];
let server;

async function main() {
  server = await createRoom({
    port: 0,
    roomName: 'Test Room',
    password: 'hunter2',
    bruteForce: {
      delayAfterFailures: 1,
      delayBaseMs: 1,
      delayCapMs: 5,
      lockThreshold: 4,
      lockWindowMs: 60_000,
      lockDurationMs: 400,
    },
    log: (line) => {
      logs.push(line);
      console.log(line);
    },
  });

  console.log(`server listening on ephemeral port ${server.port}`);
  assert.ok(server.port > 0, 'ephemeral port assigned');

  // --- /info shape ---
  const res = await fetch(`http://127.0.0.1:${server.port}/info`);
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.app, 'Beam');
  assert.equal(info.roomName, 'Test Room');
  assert.equal(info.hasPassword, true);
  assert.equal(info.roomCodeRequired, true);
  assert.equal(typeof info.version, 'string');
  assert.ok(!('ownerToken' in info), 'no owner token leaked');
  assert.ok(!('password' in info), 'no password leaked');
  assert.ok(!('salt' in info), 'no salt leaked');
  console.log('/info shape OK:', JSON.stringify(info));

  // --- wrong room code -> generic error ---
  server.resetBruteForce();
  {
    const c = await connect(`ws://127.0.0.1:${server.port}`);
    const msg = await join(c, { name: 'Alice', roomCode: 'XXXXXXXX', password: '' });
    assert.equal(msg.type, 'error');
    assert.equal(msg.code, 'auth_failed');
    assert.equal(msg.message, 'Authentication failed');
    console.log('wrong room code rejected:', JSON.stringify(msg));
  }

  // --- wrong password -> same generic error (no field hint) ---
  server.resetBruteForce();
  {
    const c = await connect(`ws://127.0.0.1:${server.port}`);
    const msg = await join(c, { name: 'Bob', roomCode: server.roomCode, password: 'wrong' });
    assert.equal(msg.type, 'error');
    assert.equal(msg.code, 'auth_failed');
    assert.equal(msg.message, 'Authentication failed');
    console.log('wrong password rejected (generic):', JSON.stringify(msg));
  }

  // --- correct join works ---
  server.resetBruteForce();
  const ownerClient = await connect(`ws://127.0.0.1:${server.port}`);
  {
    const msg = await join(ownerClient, {
      name: 'Owner',
      roomCode: server.roomCode,
      ownerToken: server.ownerToken,
    });
    assert.equal(msg.type, 'welcome');
    assert.equal(msg.youAreOwner, true);
    assert.equal(msg.roomCode, server.roomCode);
    assert.equal(msg.members.length, 1);
    assert.equal(msg.members[0].name, 'Owner');
    assert.equal(msg.members[0].isOwner, true);
    console.log('owner join OK, selfId =', msg.selfId);
  }
  const ownerId = ownerClient.messages.find((m) => m.type === 'welcome').selfId;

  // --- roster broadcast when a second member joins ---
  const secondClient = await connect(`ws://127.0.0.1:${server.port}`);
  {
    const rosterPromise = next(
      ownerClient,
      (m) => m.type === 'roster' && m.members.length === 2
    );
    const msg = await join(secondClient, {
      name: 'Member',
      roomCode: server.roomCode,
      password: 'hunter2',
    });
    assert.equal(msg.type, 'welcome');
    assert.equal(msg.youAreOwner, false);
    const roster = await rosterPromise;
    assert.equal(roster.members.length, 2);
    const names = roster.members.map((m) => m.name).sort();
    assert.deepEqual(names, ['Member', 'Owner']);
    console.log('roster broadcast OK:', JSON.stringify(names));
  }
  const memberId = secondClient.messages.find((m) => m.type === 'welcome').selfId;

  // --- owner kick ---
  {
    const kickedPromise = next(secondClient, (m) => m.type === 'kicked');
    const rosterPromise = next(
      ownerClient,
      (m) => m.type === 'roster' && m.members.length === 1
    );
    send(ownerClient, {
      type: 'owner-command',
      token: server.ownerToken,
      command: 'kick',
      target: memberId,
    });
    const kicked = await kickedPromise;
    assert.equal(kicked.type, 'kicked');
    await secondClient.closePromise;
    assert.ok(secondClient.closed, 'kicked client socket closed');
    const roster = await rosterPromise;
    assert.equal(roster.members.length, 1);
    assert.equal(roster.members[0].id, ownerId);
    console.log('owner kick OK (kicked peer id =', memberId + ')');
  }

  // --- brute-force lockout (short override) ---
  server.resetBruteForce();
  {
    // 4 consecutive failures -> lockout threshold (lockThreshold = 4)
    for (let i = 0; i < 4; i += 1) {
      const c = await connect(`ws://127.0.0.1:${server.port}`);
      const msg = await join(c, { name: 'Bad', roomCode: 'WRONGCODE', password: '' });
      assert.equal(msg.type, 'error');
      assert.equal(msg.code, 'auth_failed');
    }
    // While locked, even a CORRECT join must be rejected generically.
    const lockedClient = await connect(`ws://127.0.0.1:${server.port}`);
    const lockedMsg = await join(lockedClient, {
      name: 'Legit',
      roomCode: server.roomCode,
      password: 'hunter2',
    });
    assert.equal(lockedMsg.type, 'error');
    assert.equal(lockedMsg.code, 'auth_failed');
    console.log('brute-force lockout active (correct creds rejected):', JSON.stringify(lockedMsg));

    // Wait out the (short) lockout window.
    await sleep(600);

    const recoveredClient = await connect(`ws://127.0.0.1:${server.port}`);
    const recoveredMsg = await join(recoveredClient, {
      name: 'Recovered',
      roomCode: server.roomCode,
      password: 'hunter2',
    });
    assert.equal(recoveredMsg.type, 'welcome');
    assert.equal(recoveredMsg.youAreOwner, false);
    console.log('lockout expired, correct join succeeds again');
  }

  // Confirm failed attempts were logged with timestamp + IP.
  const authFailLogs = logs.filter((l) => l.includes('[beam][auth-fail]'));
  assert.ok(authFailLogs.length >= 4, 'failed attempts were logged');
  assert.ok(authFailLogs.every((l) => l.includes('ip=')), 'logs include ip=');
  console.log(`auth-fail log lines: ${authFailLogs.length}`);

  await server.close();
  console.log('server closed');
  console.log('ALL SERVER TESTS PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exitCode = 1;
});
