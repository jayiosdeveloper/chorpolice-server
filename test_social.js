// End-to-end test of presence + friends. Run after `node server.js`.
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://127.0.0.1:8080';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const open = (ws) => new Promise(r => ws.on('open', r));
function recv(ws, t, ms = 1500) {
  return new Promise((res) => {
    const to = setTimeout(() => res(null), ms);
    const h = (data) => { const m = JSON.parse(data.toString());
      if (m.t === t) { clearTimeout(to); ws.off('message', h); res(m); } };
    ws.on('message', h);
  });
}

(async () => {
  await new Promise(r => setTimeout(r, 800));   // let the server bind the port
  const A = new WebSocket(URL), B = new WebSocket(URL);
  A.on('error', () => {}); B.on('error', () => {});
  await Promise.all([open(A), open(B)]);
  A.send(JSON.stringify({ t: 'hello', pid: 'alice', name: 'Alice', skin: { jr: 0.2, jg: 0.5, jb: 0.9 } }));
  await recv(A, 'welcome');
  // B comes online → A should get a presence update mentioning 2 online
  const presP = recv(A, 'presence');
  B.send(JSON.stringify({ t: 'hello', pid: 'bob', name: 'Bob', skin: { jr: 0.9, jg: 0.3, jb: 0.3 } }));
  await recv(B, 'welcome');
  const pres = await presP;
  ok(pres && pres.count === 2, 'A sees presence count = 2 when B comes online');

  // A lists online players → sees Bob (paginated)
  A.send(JSON.stringify({ t: 'players', page: 0 }));
  const players = await recv(A, 'players');
  ok(players && players.total === 1 && players.items[0].pid === 'bob', 'players list shows Bob (excludes self)');
  ok(players && players.pages === 1 && players.page === 0, 'pagination fields present (page/pages)');
  ok(players && players.items[0].friend === false, 'Bob not yet a friend');

  // A sends a friend request → B receives it live
  const reqP = recv(B, 'friend_req');
  A.send(JSON.stringify({ t: 'friend_req', to: 'bob' }));
  const req = await reqP;
  ok(req && req.from && req.from.pid === 'alice' && req.from.name === 'Alice', 'B receives friend request from Alice');

  // B sees pending requests
  B.send(JSON.stringify({ t: 'requests' }));
  const reqs = await recv(B, 'requests');
  ok(reqs && reqs.items.length === 1 && reqs.items[0].pid === 'alice', 'B requests list has Alice');

  // B accepts → A is notified, both are friends
  const okP = recv(A, 'friend_ok');
  B.send(JSON.stringify({ t: 'friend_accept', from: 'alice' }));
  const friendOk = await okP;
  ok(friendOk && friendOk.with && friendOk.with.pid === 'bob', 'A notified that Bob accepted');

  A.send(JSON.stringify({ t: 'friends' }));
  const af = await recv(A, 'friends');
  ok(af && af.items.length === 1 && af.items[0].pid === 'bob' && af.items[0].online === true, 'A friends list = [Bob, online]');

  // request cleared after accept
  B.send(JSON.stringify({ t: 'requests' }));
  const reqs2 = await recv(B, 'requests');
  ok(reqs2 && reqs2.items.length === 0, 'B pending requests cleared after accept');

  // profile of Bob
  A.send(JSON.stringify({ t: 'profile', pid: 'bob' }));
  const prof = await recv(A, 'profile');
  ok(prof && prof.name === 'Bob' && prof.online === true && prof.friends === 1, 'A can view Bob profile (name/online/friends)');

  A.close(); B.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
