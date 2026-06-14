//
//  store.js — persistence for player profiles, friend requests and friendships.
//
//  Uses Upstash Redis (REST) when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//  are set (free, permanent), otherwise falls back to in-memory (resets on restart —
//  fine for testing; add Upstash env vars on the host for permanent friends).
//
//  Keys:  profile:<pid> = JSON {name, skin}     (string)
//         friends:<pid> = set of friend pids
//         req:<pid>     = set of pids who sent <pid> a pending request
//

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function makeStore() {
  if (URL && TOKEN) {
    console.log('[store] using Upstash Redis (persistent)');
    return new UpstashStore();
  }
  console.log('[store] using in-memory store (NOT persistent — set UPSTASH_REDIS_REST_URL/TOKEN for permanent friends)');
  return new MemoryStore();
}

class MemoryStore {
  constructor() { this.persistent = false; this.kind = 'memory'; this.kv = new Map(); this.sets = new Map(); }
  async ping() { return { ok: true, detail: 'in-memory (not persistent)' }; }
  _set(k) { if (!this.sets.has(k)) this.sets.set(k, new Set()); return this.sets.get(k); }
  async saveProfile(pid, prof) { this.kv.set('profile:' + pid, JSON.stringify(prof)); }
  async getProfile(pid) { const v = this.kv.get('profile:' + pid); return v ? JSON.parse(v) : null; }
  async addRequest(to, from) { this._set('req:' + to).add(from); }
  async removeRequest(to, from) { this._set('req:' + to).delete(from); }
  async getRequests(to) { return [...this._set('req:' + to)]; }
  async addFriend(a, b) { this._set('friends:' + a).add(b); this._set('friends:' + b).add(a); }
  async removeFriend(a, b) { this._set('friends:' + a).delete(b); this._set('friends:' + b).delete(a); }
  async getFriends(pid) { return [...this._set('friends:' + pid)]; }
  async isFriend(a, b) { return this._set('friends:' + a).has(b); }
}

class UpstashStore {
  constructor() { this.persistent = true; this.kind = 'upstash'; }
  async _cmd(arr) {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(arr),
      });
      const j = await res.json();
      if (j.error) { console.error('[store] upstash', arr[0], 'error:', j.error); return null; }
      return j.result;
    } catch (e) {
      console.error('[store] upstash fetch error', e && e.message);
      return null;
    }
  }
  async ping() {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(['SET', 'health:ping', 'ok']),
      });
      const j = await res.json();
      if (j.error) return { ok: false, detail: 'auth/url error: ' + j.error + ' (HTTP ' + res.status + ')' };
      const v = await this._cmd(['GET', 'health:ping']);
      return v === 'ok' ? { ok: true, detail: 'connected' }
                        : { ok: false, detail: 'unexpected result: ' + JSON.stringify(v) };
    } catch (e) {
      return { ok: false, detail: 'fetch failed: ' + (e && e.message) + ' (check UPSTASH_REDIS_REST_URL)' };
    }
  }
  async saveProfile(pid, prof) { await this._cmd(['SET', 'profile:' + pid, JSON.stringify(prof)]); }
  async getProfile(pid) { const v = await this._cmd(['GET', 'profile:' + pid]); return v ? JSON.parse(v) : null; }
  async addRequest(to, from) { await this._cmd(['SADD', 'req:' + to, from]); }
  async removeRequest(to, from) { await this._cmd(['SREM', 'req:' + to, from]); }
  async getRequests(to) { return (await this._cmd(['SMEMBERS', 'req:' + to])) || []; }
  async addFriend(a, b) { await this._cmd(['SADD', 'friends:' + a, b]); await this._cmd(['SADD', 'friends:' + b, a]); }
  async removeFriend(a, b) { await this._cmd(['SREM', 'friends:' + a, b]); await this._cmd(['SREM', 'friends:' + b, a]); }
  async getFriends(pid) { return (await this._cmd(['SMEMBERS', 'friends:' + pid])) || []; }
  async isFriend(a, b) { return (await this._cmd(['SISMEMBER', 'friends:' + a, b])) === 1; }
}

module.exports = { makeStore, makeMemoryStore: () => new MemoryStore() };
