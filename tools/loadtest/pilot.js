// VendorGate pilot-size load: 150 staff + 50 suppliers browsing with think time, 49 bidders bidding in one live auction,
// and (after contracts_setup.py) contract managers on 5,000 contracts plus 20 other parties reviewing contracts.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
const T = JSON.parse(open('./tokens.json'));
const B = __ENV.BASE || 'http://localhost:4800';
const SCALE = Number(__ENV.SCALE || 1);
const bidOk = new Counter('bids_accepted'); const bidRejected = new Counter('bids_rejected_by_rules'); const bidTime = new Trend('bid_ms', true);
const hdr = (cookie, ip) => ({ headers: { 'X-Requested-With': 'fetch', Cookie: cookie, 'X-Forwarded-For': ip, 'Content-Type': 'application/json' }, tags: {} });
const ip = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
const ramp = (target, hold) => [{ duration: '30s', target }, { duration: hold, target }, { duration: '10s', target: 0 }];

export const options = {
  discardResponseBodies: false,
  scenarios: {
    staff: { executor: 'ramping-vus', exec: 'staff', stages: ramp(150 * SCALE, __ENV.HOLD || '3m') },
    suppliers: { executor: 'ramping-vus', exec: 'supplier', stages: ramp(50 * SCALE, __ENV.HOLD || '3m') },
    bidders: { executor: 'ramping-vus', exec: 'bidder', stages: ramp(49, __ENV.HOLD || '3m') },
    ...(T.contracts && __ENV.CONTRACTS !== '0' ? {
      contracts: { executor: 'ramping-vus', exec: 'contracts', stages: ramp(30 * SCALE, __ENV.HOLD || '3m') },
      reviewers: { executor: 'ramping-vus', exec: 'reviewer', stages: ramp(T.reviewers.length, __ENV.HOLD || '3m') },
    } : {}),
  },
  thresholds: { 'http_req_failed': ['rate<0.01'], 'http_req_duration{kind:page}': ['p(95)<800'], 'bid_ms': ['p(95)<500'] },
};
const get = (url, o, name) => { o.tags = { kind: 'page', name }; const r = http.get(B + url, o); check(r, { [`${name} 200`]: (x) => x.status === 200 }); return r; };

// Sessions were made in the order admin, buyer, finance, tax, MDM; only some roles see reports and sourcing.
export function staff() {
  const n = (__VU - 1) % T.staff.length, role = n % 5; const o = hdr(`vg_s=${T.staff[n]}`, ip(__VU));
  const reports = role !== 3, sourcing = role <= 2;
  get('/api/auth/me', o, 'me');
  if (reports) get('/api/reports/dashboard', o, 'dashboard'); sleep(2 + Math.random() * 4);
  const list = get(`/api/staff/vendors?page=${1 + (__ITER % 20)}`, o, 'vendor list'); sleep(1 + Math.random() * 3);
  get(`/api/staff/vendors?q=Load%20Supplier%20${__ITER % 300}`, o, 'vendor search'); sleep(1 + Math.random() * 2);
  get(`/api/staff/vendors/${T.vendorIds[(__VU * 7 + __ITER) % T.vendorIds.length]}`, o, 'vendor detail'); sleep(3 + Math.random() * 5);
  if (__ITER % 3 === 0) { get('/api/staff/risk', o, 'risk'); sleep(2 + Math.random() * 3); }
  if (sourcing && __ITER % 4 === 0) { get('/api/staff/sourcing/events', o, 'sourcing events'); get(`/api/staff/sourcing/events/${T.event}`, o, 'sourcing event'); sleep(2 + Math.random() * 3); }
  if (reports && __ITER % 5 === 0) { get('/api/reports/vendor-register', o, 'report'); sleep(3); }
}
export function supplier() {
  const o = hdr(`vg_v=${T.suppliers[(__VU - 1) % T.suppliers.length]}`, ip(100000 + __VU));
  get('/api/vendor', o, 'portal'); sleep(3 + Math.random() * 5);
  get('/api/vendor/guide', o, 'guide'); sleep(2 + Math.random() * 4);
  get('/api/vendor/events', o, 'my events'); sleep(4 + Math.random() * 6);
}
export function bidder() {
  const i = (__VU - 1) % 49; const o = hdr(`vg_v=${T.bidders[i]}`, ip(200000 + i));
  const live = get(`/api/vendor/events/${T.event}/live`, o, 'live view');
  const lot = (live.json('lots') || [])[__ITER % 2]; if (!lot) { sleep(2); return; }
  // Bid just under the most this bidder may bid now (their own last bid minus the step, or the start price).
  const amount = Math.floor((lot.maxNext ?? lot.startPrice) - Math.random() * 500);
  const r = http.post(`${B}/api/vendor/events/${T.event}/bids`, JSON.stringify({ lotId: lot.id, amount }), { ...o, tags: { kind: 'bid', name: 'bid' }, responseCallback: http.expectedStatuses({ min: 200, max: 409 }) });
  bidTime.add(r.timings.duration);
  if (r.status === 201 || r.status === 200) bidOk.add(1); else if (r.status < 500) bidRejected.add(1);
  check(r, { 'bid not 5xx': (x) => x.status < 500 });
  sleep(2 + Math.random() * 4);
}

// Contract managers (admin sessions): lists, search, a contract, obligations, reports; now and then read an uploaded Word contract.
export function contracts() {
  const o = hdr(`vg_s=${T.staff[((__VU - 1) * 5) % T.staff.length]}`, ip(300000 + __VU));
  get(`/api/staff/contracts?page=${1 + (__ITER % 30)}`, o, 'contract list'); sleep(1 + Math.random() * 3);
  get(`/api/staff/contracts?tab=expiring`, o, 'contracts expiring'); sleep(1 + Math.random() * 2);
  get(`/api/staff/contracts?q=Load%20contract%20${(__VU * 13 + __ITER) % 5000}`, o, 'contract search'); sleep(1 + Math.random() * 2);
  get(`/api/staff/contracts/${T.contracts[(__VU * 7 + __ITER) % T.contracts.length]}`, o, 'contract detail'); sleep(3 + Math.random() * 5);
  if (__ITER % 2 === 0) { get('/api/staff/contracts/obligations?filter=overdue', o, 'obligations'); sleep(2 + Math.random() * 3); }
  if (__ITER % 3 === 0) { get('/api/staff/contracts/reports', o, 'contract reports'); sleep(3 + Math.random() * 3); }
  if (__ITER % 10 === 0) { get('/api/staff/parties?page=1', o, 'parties'); sleep(2); }
  if (Math.random() < 0.15) { // about one contract read every few minutes per manager
    const r = http.post(`${B}/api/staff/contracts/${T.readContract}/files/${T.readFile}/read`, null, { ...o, tags: { kind: 'page', name: 'read contract' } });
    check(r, { 'read contract 200': (x) => x.status === 200 }); sleep(3);
  }
}
// The other party, signed in with the email link + code, reading the contract and its versions.
export function reviewer() {
  const o = hdr(`vg_c=${T.reviewers[(__VU - 1) % T.reviewers.length]}`, ip(400000 + __VU));
  get('/api/review/session', o, 'review view'); sleep(5 + Math.random() * 10);
}
