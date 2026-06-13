// Quick end-to-end check of the relay: A creates a private room, B lists + joins,
// owner settings + start + in-game relay are verified. Run after `node server.js`.
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://127.0.0.1:8080';
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; log('  PASS', m); } else { fail++; log('  FAIL', m); } };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const open = (ws) => new Promise(r => ws.on('open', r));
function recv(ws, t, ms = 1500) {
  return new Promise((res) => {
    const to = setTimeout(() => res(null), ms);
    const h = (data) => {
      const m = JSON.parse(data.toString());
      if (m.t === t) { clearTimeout(to); ws.off('message', h); res(m); }
    };
    ws.on('message', h);
  });
}

(async () => {
  const A = new WebSocket(URL), B = new WebSocket(URL);
  await Promise.all([open(A), open(B)]);

  A.send(JSON.stringify({ t: 'hello', name: 'Owner', skin: { jr: 0.2, jg: 0.5, jb: 0.9 } }));
  B.send(JSON.stringify({ t: 'hello', name: 'Buddy', skin: { jr: 0.9, jg: 0.3, jb: 0.3 } }));
  await recv(A, 'welcome'); await recv(B, 'welcome');

  // A creates a PRIVATE room (code + password), settings carried
  A.send(JSON.stringify({ t: 'create', public: false, password: 'secret', max: 20,
    settings: { map: 3, mode: 1, target: 15, minutes: 7, unlimited: true } }));
  const joinedA = await recv(A, 'joined');
  ok(joinedA && joinedA.you === 1, 'owner gets id 1');
  ok(joinedA && joinedA.code && joinedA.code.length === 5, 'room code generated: ' + (joinedA && joinedA.code));
  const code = joinedA.code;

  // public list should NOT show the private room
  B.send(JSON.stringify({ t: 'list' }));
  const list = await recv(B, 'rooms');
  ok(list && list.rooms.length === 0, 'private room hidden from public list');

  // wrong password rejected
  B.send(JSON.stringify({ t: 'join', code, password: 'wrong' }));
  const err = await recv(B, 'error');
  ok(err && err.code === 'bad_password', 'wrong password rejected');

  // correct password joins; owner sees roster grow
  B.send(JSON.stringify({ t: 'join', code, password: 'secret' }));
  const joinedB = await recv(B, 'joined');
  ok(joinedB && joinedB.you === 2, 'second player gets id 2');
  ok(joinedB && joinedB.settings && joinedB.settings.target === 15, 'joiner receives owner settings (target=15)');
  ok(joinedB && joinedB.settings.unlimited === true, 'joiner receives unlimited=true');
  const rosterA = await recv(A, 'roster');
  ok(rosterA && Object.keys(rosterA.roster).length === 2, 'owner sees 2 players in roster');

  // owner starts → B receives start with the owner's settings
  A.send(JSON.stringify({ t: 'start' }));
  const startB = await recv(B, 'start');
  ok(startB && startB.settings && startB.settings.map === 3, 'start broadcasts owner settings (map=3)');

  // in-game relay: A sends m, B receives it tagged from:1
  A.send(JSON.stringify({ t: 'm', d: { t: 'state', x: 100, y: -50, k: 2 }, r: 0 }));
  const relay = await recv(B, 'm');
  ok(relay && relay.from === 1 && relay.d && relay.d.k === 2, 'in-game packet relayed (from=1, payload intact)');

  // non-owner cannot start
  B.send(JSON.stringify({ t: 'start' }));
  const notOwner = await recv(B, 'error');
  ok(notOwner && notOwner.code === 'not_owner', 'non-owner cannot start');

  await wait(100);
  A.close(); B.close();
  log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
