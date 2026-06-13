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
  constructor() { this.persistent = false; this.kv = new Map(); this.sets = new Map(); }
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
  constructor() { this.persistent = true; }
  async _cmd(arr) {
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(arr),
      });
      const j = await res.json();
      return j.result;
    } catch (e) {
      console.error('[store] upstash error', e && e.message);
      return null;
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

module.exports = { makeStore };
