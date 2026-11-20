// Opens one live-update stream per bidder (and some buyers) and measures how long after a probe bid each stream hears about it.
import fs from 'node:fs';
import http from 'node:http';
const T = JSON.parse(fs.readFileSync(new URL('./tokens.json', import.meta.url)));
const N = Number(process.env.STREAMS || 50), SECS = Number(process.env.SECS || 150);
const streams = [];
let probeAt = 0; const lat = []; let connected = 0, dropped = 0;
function open(i) {
  const cookie = `vg_v=${T.bidders[i % T.bidders.length]}`;
  const req = http.get({ host: 'localhost', port: 4800, path: `/api/vendor/events/${T.event}/stream`, headers: { Cookie: cookie, 'X-Requested-With': 'fetch', Accept: 'text/event-stream', 'X-Forwarded-For': `10.9.${i >> 8}.${i & 255}` } }, (res) => {
    if (res.statusCode !== 200) { console.log('stream', i, res.statusCode); return; }
    connected++; const s = { heard: true };
    streams.push(s);
    res.on('data', (c) => { if (String(c).includes('data:') && probeAt && !s.heard) { s.heard = true; lat.push(Date.now() - probeAt); } });
    res.on('end', () => { dropped++; });
  });
  req.on('error', () => { dropped++; });
}
for (let i = 0; i < N; i++) open(i);
const probe = T.bidders[T.bidders.length - 1];
async function bid() {
  const live = await (await fetch(`http://localhost:4800/api/vendor/events/${T.event}/live`, { headers: { Cookie: `vg_v=${probe}`, 'X-Requested-With': 'fetch', 'X-Forwarded-For': '10.8.0.1' } })).json();
  const lot = live.lots[0];
  for (const s of streams) s.heard = false;
  probeAt = Date.now();
  const r = await fetch(`http://localhost:4800/api/vendor/events/${T.event}/bids`, { method: 'POST', headers: { Cookie: `vg_v=${probe}`, 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', 'X-Forwarded-For': '10.8.0.1' }, body: JSON.stringify({ lotId: lot.id, amount: Math.floor(lot.maxNext ?? lot.startPrice) - 1 }) });
  if (r.status >= 300) console.log('probe bid', r.status, (await r.text()).slice(0, 120));
}
const t = setInterval(bid, 5000);
setTimeout(() => {
  clearInterval(t); lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
  console.log(JSON.stringify({ streams: N, connected, dropped, updates: lat.length, medMs: q(0.5), p95Ms: q(0.95), maxMs: lat[lat.length - 1] }));
  process.exit(0);
}, SECS * 1000);
