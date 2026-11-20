// 49 bidders bidding as fast as they can on one auction: how many bids per second the auction takes.
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
const T = JSON.parse(open('./tokens.json'));
const B = 'http://localhost:4800';
const ok = new Counter('bids_accepted'); const t = new Trend('bid_ms', true);
export const options = { scenarios: { storm: { executor: 'constant-vus', vus: 49, duration: '45s' } } };
export default function () {
  const i = __VU - 1; const o = { headers: { 'X-Requested-With': 'fetch', Cookie: `vg_v=${T.bidders[i]}`, 'Content-Type': 'application/json', 'X-Forwarded-For': `10.7.0.${i}` }, tags: { name: 'live view' } };
  const lot = (http.get(`${B}/api/vendor/events/${T.event}/live`, o).json('lots') || [])[__ITER % 2]; if (!lot) return;
  const r = http.post(`${B}/api/vendor/events/${T.event}/bids`, JSON.stringify({ lotId: lot.id, amount: Math.floor((lot.maxNext ?? lot.startPrice) - Math.random() * 100) }), { ...o, tags: { name: 'bid' }, responseCallback: http.expectedStatuses({ min: 200, max: 409 }) });
  t.add(r.timings.duration); if (r.status === 201 || r.status === 200) ok.add(1);
}
