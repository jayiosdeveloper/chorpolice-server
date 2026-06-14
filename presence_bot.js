// A fake online player ("TestBot") for testing the Players/Friends UI on a device.
// Connects to the live server, stays online, and auto-accepts friend requests.
const WebSocket = require('ws');
const URL = process.env.URL || 'wss://chorpolice-relay.onrender.com';
const NAME = process.env.NAME || 'TestBot';
const PID = process.env.PID || 'testbot-001';
const ws = new WebSocket(URL);
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', pid: PID, name: NAME, skin: { jr: 0.9, jg: 0.4, jb: 0.2 } }));
  console.log(NAME, 'online as', PID);
});
ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.t === 'friend_req') {
    console.log('friend request from', m.from.name, '— accepting');
    ws.send(JSON.stringify({ t: 'friend_accept', from: m.from.pid }));
  }
});
ws.on('error', (e) => console.error('err', e.message));
ws.on('close', () => console.log('closed'));
