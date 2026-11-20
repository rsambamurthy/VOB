#!/bin/bash
# Restart the production server and run a k6 scenario; prints per-endpoint latency.
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
pkill -f "dist/index.js"; sleep 1
cd "$HERE/../../server"
(NODE_ENV=production PORT=4800 ENCRYPTION_KEY=${ENCRYPTION_KEY:?set ENCRYPTION_KEY} DATABASE_URL=postgresql://vendor:vendor@localhost:5432/vendor_onboarding_load_e2e APP_BASE_URL=https://load.test DEV_SHOW_OTP=false TRUST_PROXY=true JOBS_ENABLED=true UPLOAD_DIR=/tmp/vg-load-uploads LOG_LEVEL=warn ${NODEOPTS} nohup node $NODEFLAGS dist/index.js > /tmp/vg-load.log 2>&1 &)
cd "$HERE"; for i in $(seq 1 30); do curl -sf localhost:4800/api/health >/dev/null && break; sleep 1; done
E=$(python3 -c "import json;print(json.load(open('tokens.json'))['event'])")
PGPASSWORD=vendor psql -h localhost -U vendor -d vendor_onboarding_load_e2e -qc "update sourcing_events set live_starts_at=now()-interval '1 minute', live_ends_at=now()+interval '40 minutes', status='LIVE', paused_at=null where id='$E'"
(sleep ${TOPAT:-60}; top -bn1 -o %CPU | sed -n 7,10p > top.txt) &
k6 run --quiet --summary-trend-stats="avg,med,p(95),p(99),max" --out json=run.json "$@" ${SCRIPT:-pilot.js} 2>&1 | grep -v "level=warning" | grep -E "http_req_failed|http_reqs|kind:page|bid_ms|bids_|checks|✗|vus_max" 
wait; cat top.txt
python3 - <<'PY'
import json,collections
d=collections.defaultdict(list)
for line in open('run.json'):
    o=json.loads(line)
    if o.get('type')=='Point' and o['metric']=='http_req_duration': d[o['data']['tags'].get('name','?')].append(o['data']['value'])
for k,v in sorted(d.items(), key=lambda x:-sum(x[1])):
    v.sort(); print(f"{k:18} n={len(v):5} med={v[len(v)//2]:6.0f} p95={v[int(len(v)*.95)]:6.0f} max={v[-1]:6.0f}")
PY
