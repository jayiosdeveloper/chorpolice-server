# Chor Police — Online Relay Server

Cloud version of a LAN host: clients connect over WebSocket, the server hosts
**rooms** and **relays** game packets. The in-game payload is the SAME JSON the
LAN build uses, so **iOS ↔ Android cross-play works** and the game code is unchanged.
The room **owner's settings apply to every player**.

- `server.js` — the relay (rooms: public/private, code+password, max 20, owner settings, message relay)
- `test_client.js` — end-to-end self test
- One dependency: `ws`

---

## 1. Run locally (free, no account — test first)

```bash
cd chorpolice-server
npm install
node server.js          # listens on :8080
```

Test it:
```bash
node test_client.js     # in another terminal — expect "11 passed, 0 failed"
```

Connect the phones to your Mac over the same WiFi:
- Find your Mac IP: `ipconfig getifaddr en0` (e.g. `192.168.1.5`)
- Client server URL → `ws://192.168.1.5:8080`
- **Android** connects to `ws://` directly.
- **iOS** blocks plain `ws://` by default (App Transport Security). For LOCAL testing
  add an ATS exception, or just test iOS against the cloud `wss://` URL (below).

---

## 2. Deploy free + always-on (recommended: Oracle Cloud Always Free)

Truly free forever, always-on, no sleep. One-time ~20 min setup. Gives `wss://`
(TLS) so **both iOS and Android** connect with no ATS hassle.

1. **Create VM**: Oracle Cloud → Always Free → Compute Instance → *Ampere (ARM) Ubuntu 22.04*.
2. **Open ports**: VCN Security List → ingress for TCP **80** and **443** (0.0.0.0/0).
   Also on the VM: `sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT && sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT` (then `sudo netfilter-persistent save`).
3. **Free domain** (for TLS): create one at https://www.duckdns.org → e.g. `chorpolice.duckdns.org` → point it to the VM's public IP.
4. **Install Node + the app**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   # copy server.js + package.json to ~/chorpolice-server, then:
   cd ~/chorpolice-server && npm install
   sudo npm i -g pm2 && pm2 start server.js && pm2 startup && pm2 save
   ```
5. **Auto-TLS with Caddy** (turns :8080 into `wss://chorpolice.duckdns.org`):
   ```bash
   sudo apt install -y caddy
   echo 'chorpolice.duckdns.org {
       reverse_proxy localhost:8080
   }' | sudo tee /etc/caddy/Caddyfile
   sudo systemctl restart caddy
   ```
6. Client server URL → `wss://chorpolice.duckdns.org`  ✅ works on iOS + Android.

---

## 3. Deploy alternative: Fly.io (easiest `wss://`, needs a card)

Instant free `wss://app.fly.dev` with TLS. Always-on costs ~$2/mo, or set
`min_machines_running = 0` for free-with-cold-start.

```bash
# install flyctl, then in this folder:
fly launch --no-deploy        # creates fly.toml (set internal_port = 8080)
fly deploy
```
Client URL → `wss://<your-app>.fly.dev`.

> Render.com also gives instant free `wss://app.onrender.com` (no card) but the
> free instance **sleeps** after 15 min idle (first join waits ~30–60s).

---

## Wire protocol (reference)

client → server: `hello` · `list` · `create` · `join` · `leave` · `settings` · `start` · `m`
server → client: `welcome` · `rooms` · `joined` · `roster` · `settings` · `start` · `m` · `error`

The `m` message carries `d` = the existing in-game JSON (state/fire/hit/…), relayed
to the other room members. Owner = player id 1; their `settings` drive the match.
