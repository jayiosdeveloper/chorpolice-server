//
//  Chor Police — online relay server.
//
//  Plays the SAME role as a LAN host, but in the cloud: clients connect over
//  WebSocket, the server hosts rooms and relays game packets between the players
//  of a room. The in-game payload ("d") is opaque JSON — the SAME format the LAN
//  build already uses (state/fire/hit/...) — so iOS and Android interoperate and
//  the game code does not change. The room OWNER's settings apply to everyone.
//
//  Wire protocol (JSON text frames):
//   client -> server:
//     {t:"hello", name, skin}                         identity (sent once on connect)
//     {t:"list"}                                       ask for public rooms
//     {t:"create", public:bool, password, max, settings}   create + own a room
//     {t:"join", code, password}                       join a room by code
//     {t:"leave"}                                      leave current room
//     {t:"settings", settings}                         owner updates match settings
//     {t:"start"}                                      owner starts the match
//     {t:"m", d, r}                                    in-game packet to relay (r=1 reliable hint)
//   server -> client:
//     {t:"welcome"}                                    connected
//     {t:"rooms", rooms:[{code,name,players,max,mode,map}]}
//     {t:"joined", code, you, owner, roster, settings}
//     {t:"roster", roster, owner}                      players changed
//     {t:"settings", settings}                         owner changed settings
//     {t:"start", settings}                            match starting
//     {t:"m", from, d}                                 relayed in-game packet
//     {t:"error", code}                                room_full | bad_password | no_room | not_owner
//
//  roster = { "<id>": {name, skin, team, owner:bool} }   (owner id = 1)
//

const http = require('http');
const { WebSocketServer } = require('ws');
const { makeStore } = require('./store');

const PORT = process.env.PORT || 8080;
const MAX_CAP = 20;          // hard ceiling for any room (public requirement)
const CODE_LEN = 5;          // shareable room code length
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
const PAGE = 20;             // online-players page size

/** @type {Map<string, Room>} code -> room */
const rooms = new Map();

// social: presence + persistent friends
const store = makeStore();
/** @type {Map<string, WebSocket>} pid -> connection (online players) */
const online = new Map();

// ---- tiny helpers -------------------------------------------------------

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < CODE_LEN; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function clampMax(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) return MAX_CAP;
  return Math.max(2, Math.min(MAX_CAP, n));
}

// ---- room model ---------------------------------------------------------

class Room {
  constructor(code, isPublic, password, max, settings) {
    this.code = code;
    this.isPublic = !!isPublic;
    this.password = password ? String(password) : '';
    this.max = clampMax(max);
    this.settings = settings && typeof settings === 'object' ? settings : {};
    this.ownerId = 1;
    this.nextId = 1;
    /** @type {Map<WebSocket, Player>} */
    this.members = new Map();
  }

  size() { return this.members.size; }

  roster() {
    const r = {};
    for (const p of this.members.values()) {
      r[String(p.id)] = { name: p.name, skin: p.skin, team: p.team, owner: p.id === this.ownerId };
    }
    return r;
  }

  broadcast(obj, exceptWs = null) {
    for (const ws of this.members.keys()) {
      if (ws !== exceptWs) send(ws, obj);
    }
  }

  summary() {
    return {
      code: this.code,
      name: this.ownerName(),
      players: this.size(),
      max: this.max,
      mode: this.settings.mode | 0,
      map: this.settings.map | 0,
    };
  }

  ownerName() {
    for (const p of this.members.values()) if (p.id === this.ownerId) return p.name;
    return 'Host';
  }
}

class Player {
  constructor(id, name, skin) {
    this.id = id;
    this.name = name || ('Player' + id);
    this.skin = skin || {};
    this.team = -1;
  }
}

// ---- joining / leaving --------------------------------------------------

function joinRoom(ws, room) {
  const id = room.nextId++;
  const p = new Player(id, ws.identity.name, ws.identity.skin);
  room.members.set(ws, p);
  ws.room = room;
  ws.playerId = id;
  send(ws, {
    t: 'joined', code: room.code, you: id, owner: room.ownerId,
    roster: room.roster(), settings: room.settings,
  });
  room.broadcast({ t: 'roster', roster: room.roster(), owner: room.ownerId });
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  const wasOwner = ws.playerId === room.ownerId;
  room.members.delete(ws);
  ws.room = null;
  ws.playerId = 0;
  if (room.size() === 0) {
    rooms.delete(room.code);
    return;
  }
  if (wasOwner) {
    // promote the lowest remaining id to owner (settings authority lives on)
    let lowest = Infinity;
    for (const p of room.members.values()) lowest = Math.min(lowest, p.id);
    room.ownerId = lowest;
  }
  room.broadcast({ t: 'roster', roster: room.roster(), owner: room.ownerId });
}

// ---- message handling ---------------------------------------------------

function handle(ws, msg) {
  switch (msg.t) {
    case 'hello':
      ws.identity = { name: String(msg.name || 'Player').slice(0, 24), skin: msg.skin || {} };
      ws.pid = msg.pid ? String(msg.pid).slice(0, 48) : null;
      if (ws.pid) registerPresence(ws);
      send(ws, { t: 'welcome' });
      break;

    case 'list': {
      const list = [];
      for (const room of rooms.values()) if (room.isPublic) list.push(room.summary());
      send(ws, { t: 'rooms', rooms: list });
      break;
    }

    case 'create': {
      if (ws.room) leaveRoom(ws);
      const code = makeCode();
      const room = new Room(code, msg.public, msg.password, msg.max, msg.settings);
      rooms.set(code, room);
      joinRoom(ws, room);                 // creator becomes owner (id 1)
      break;
    }

    case 'join': {
      const room = rooms.get(String(msg.code || '').toUpperCase());
      if (!room) { send(ws, { t: 'error', code: 'no_room' }); break; }
      if (room.password && room.password !== String(msg.password || '')) {
        send(ws, { t: 'error', code: 'bad_password' }); break;
      }
      if (room.size() >= room.max) { send(ws, { t: 'error', code: 'room_full' }); break; }
      if (ws.room) leaveRoom(ws);
      joinRoom(ws, room);
      break;
    }

    case 'leave':
      leaveRoom(ws);
      break;

    case 'settings': {
      const room = ws.room;
      if (!room) break;
      if (ws.playerId !== room.ownerId) { send(ws, { t: 'error', code: 'not_owner' }); break; }
      if (msg.settings && typeof msg.settings === 'object') room.settings = msg.settings;
      room.broadcast({ t: 'settings', settings: room.settings });
      break;
    }

    case 'start': {
      const room = ws.room;
      if (!room) break;
      if (ws.playerId !== room.ownerId) { send(ws, { t: 'error', code: 'not_owner' }); break; }
      room.broadcast({ t: 'start', settings: room.settings });
      break;
    }

    case 'm': {
      const room = ws.room;
      if (!room) break;
      room.broadcast({ t: 'm', from: ws.playerId, d: msg.d }, ws);  // relay to OTHERS
      break;
    }

    // social (presence + friends)
    case 'players':        sendPlayers(ws, msg);   break;
    case 'friend_req':     friendReq(ws, msg);     break;
    case 'friend_accept':  friendAccept(ws, msg);  break;
    case 'friend_decline': friendDecline(ws, msg); break;
    case 'unfriend':       unfriend(ws, msg);      break;
    case 'friends':        sendFriends(ws);        break;
    case 'requests':       sendRequests(ws);       break;
    case 'profile':        sendProfile(ws, msg);   break;
  }
}

// ---- social: presence + friends -----------------------------------------

function registerPresence(ws) {
  const old = online.get(ws.pid);
  if (old && old !== ws) { try { old.close(); } catch {} }   // a pid reconnected
  online.set(ws.pid, ws);
  store.saveProfile(ws.pid, { name: ws.identity.name, skin: ws.identity.skin });
  broadcastPresence();
  sendRequests(ws);             // deliver any pending friend requests
}

function broadcastPresence() {
  const count = online.size;
  for (const ws of wss.clients) send(ws, { t: 'presence', count });
}

function profileItem(pid, prof) {
  return { pid, name: (prof && prof.name) || 'Player', skin: (prof && prof.skin) || {}, online: online.has(pid) };
}

async function sendPlayers(ws, msg) {
  const page = Math.max(0, parseInt(msg.page, 10) || 0);
  const me = ws.pid;
  const friendSet = new Set(me ? await store.getFriends(me) : []);
  const items = [];
  for (const [pid, w] of online) {
    if (pid === me) continue;
    items.push({ pid, name: w.identity.name, skin: w.identity.skin, online: true, friend: friendSet.has(pid) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  send(ws, { t: 'players', page, pages, total, items: items.slice(page * PAGE, page * PAGE + PAGE) });
}

async function friendReq(ws, msg) {
  const me = ws.pid, to = String(msg.to || '');
  if (!me || !to || to === me) return;
  if (await store.isFriend(me, to)) return;
  await store.addRequest(to, me);
  const w = online.get(to);
  if (w) send(w, { t: 'friend_req', from: profileItem(me, ws.identity) });
  send(ws, { t: 'ok', what: 'friend_req' });
}

async function friendAccept(ws, msg) {
  const me = ws.pid, from = String(msg.from || '');
  if (!me || !from) return;
  const reqs = await store.getRequests(me);
  if (!reqs.includes(from)) return;
  await store.removeRequest(me, from);
  await store.addFriend(me, from);
  sendFriends(ws);
  const w = online.get(from);
  if (w) { send(w, { t: 'friend_ok', with: profileItem(me, ws.identity) }); sendFriends(w); }
}

async function friendDecline(ws, msg) {
  const me = ws.pid, from = String(msg.from || '');
  if (me && from) { await store.removeRequest(me, from); sendRequests(ws); }
}

async function unfriend(ws, msg) {
  const me = ws.pid, pid = String(msg.pid || '');
  if (me && pid) { await store.removeFriend(me, pid); sendFriends(ws); }
}

async function sendFriends(ws) {
  if (!ws.pid) { send(ws, { t: 'friends', items: [] }); return; }
  const ids = await store.getFriends(ws.pid);
  const items = [];
  for (const pid of ids) items.push(profileItem(pid, await store.getProfile(pid)));
  items.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  send(ws, { t: 'friends', items });
}

async function sendRequests(ws) {
  if (!ws.pid) { send(ws, { t: 'requests', items: [] }); return; }
  const ids = await store.getRequests(ws.pid);
  const items = [];
  for (const pid of ids) items.push(profileItem(pid, await store.getProfile(pid)));
  send(ws, { t: 'requests', items });
}

async function sendProfile(ws, msg) {
  const pid = String(msg.pid || '');
  if (!pid) return;
  const prof = await store.getProfile(pid);
  const friends = await store.getFriends(pid);
  send(ws, { t: 'profile', pid, name: (prof && prof.name) || 'Player',
             skin: (prof && prof.skin) || {}, online: online.has(pid), friends: friends.length });
}

// ---- server + heartbeat -------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  if (req.url && req.url.startsWith('/health')) {
    const p = await store.ping();
    res.end(`store=${store.kind}  ok=${p.ok}  ${p.detail}\nrooms=${rooms.size}  online=${online.size}`);
  } else {
    res.end('Chor Police relay OK. rooms=' + rooms.size + ' store=' + store.kind);
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.identity = { name: 'Player', skin: {} };
  ws.room = null;
  ws.playerId = 0;
  ws.pid = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg && typeof msg === 'object' && typeof msg.t === 'string') handle(ws, msg);
  });

  ws.on('close', () => {
    leaveRoom(ws);
    if (ws.pid && online.get(ws.pid) === ws) { online.delete(ws.pid); broadcastPresence(); }
  });
  ws.on('error', () => {});
});

// drop dead connections so empty rooms get cleaned up
const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(beat));

httpServer.listen(PORT, () => {
  console.log('Chor Police relay listening on :' + PORT);
});
