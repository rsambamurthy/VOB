"""Load-test data: 3,000 extra suppliers, staff and supplier sessions, and a reverse auction with 50 accepted bidders."""
import json, os, subprocess, sys, requests
from concurrent.futures import ThreadPoolExecutor
B = 'http://localhost:4800'; H = {'X-Requested-With': 'fetch'}
DB = ['psql', '-h', 'localhost', '-U', 'vendor', '-d', 'vendor_onboarding_load_e2e', '-tAc']
def psql(q): return subprocess.check_output(DB + [q], env={'PGPASSWORD': 'vendor', 'PATH': '/usr/bin:/bin'}).decode().strip()

psql("""DO $$ DECLARE r vendors; i int; BEGIN
SELECT * INTO r FROM vendors WHERE code='VND-00001' AND tenant_id=(select id from tenants where slug='acme');
FOR i IN 1..3000 LOOP
 r.id:=gen_random_uuid(); r.code:='VND-L'||lpad(i::text,5,'0'); r.name:='Load Supplier '||i||' Pvt Ltd';
 r.contact_email:='load'||i||'@load.test'; r.invite_token:=md5(random()::text)||i;
 r.status:=(array['APPROVED','APPROVED','IN_PROGRESS','UNDER_REVIEW','INVITED'])[1+i%5];
 INSERT INTO vendors SELECT r.*; END LOOP; END $$;""")
print('vendors', psql("select count(*) from vendors"))

def staff_session(email):
    s = requests.Session(); r = s.post(B + '/api/auth/login', json={'workspace': 'acme', 'email': email, 'password': 'Demo@12345'}, headers=H)
    assert r.status_code == 200, r.text
    return s.cookies.get('vg_s')
STAFF = ['admin@acme.test', 'buyer@acme.test', 'finance@acme.test', 'tax@acme.test', 'mdm@acme.test']
with ThreadPoolExecutor(8) as ex: staff = list(ex.map(staff_session, [STAFF[i % len(STAFF)] for i in range(150)]))

def vendor_session(token):
    s = requests.Session()
    o = s.post(B + '/api/vendor-auth/request-otp', json={'token': token}, headers=H).json()
    r = s.post(B + '/api/vendor-auth/verify-otp', json={'token': token, 'code': o['devOtp']}, headers=H); assert r.status_code == 200, r.text
    me = s.get(B + '/api/vendor', headers=H).json()
    if not me['privacy'].get('consentAt'): s.post(B + '/api/vendor/consent', json={'version': me['privacy']['version']}, headers=H)
    return s.cookies.get('vg_v'), s
tokens = psql("select invite_token from vendors where code like 'VND-L%' and status in ('APPROVED','IN_PROGRESS') order by code limit 100").split('\n')
with ThreadPoolExecutor(8) as ex: suppliers = [c for c, _ in ex.map(vendor_session, tokens)]

# Reverse auction with 50 outside bidders who accepted.
buyer = requests.Session(); buyer.post(B + '/api/auth/login', json={'workspace': 'acme', 'email': 'buyer@acme.test', 'password': 'Demo@12345'}, headers=H)
psql("update tenants set limits = coalesce(limits,'{}'::jsonb) || '{\"features\": {\"sourcing\": true}}' where slug='acme'")
adm = requests.Session(); adm.post(B + '/api/auth/login', json={'workspace': 'acme', 'email': 'admin@acme.test', 'password': 'Demo@12345'}, headers=H)
assert adm.put(B + '/api/admin/sourcing', json={'enabled': True, 'formats': {'rfq': True, 'reverse': True}}, headers=H).status_code == 200
adm.put(B + '/api/admin/sourcing/approval', json={'levels': []}, headers=H)
from datetime import datetime, timedelta, timezone
iso = lambda h: (datetime.now(timezone.utc) + timedelta(hours=h)).isoformat()
e = buyer.post(B + '/api/staff/sourcing/events', json={'title': 'Load auction', 'format': 'reverse', 'estimatedValue': 900000, 'liveStartsAt': iso(2), 'liveEndsAt': iso(3)}, headers=H).json()['event']
assert buyer.put(B + f"/api/staff/sourcing/events/{e['id']}/items", json={'lots': [{'title': 'Steel', 'bidMode': 'lot', 'startPrice': 10000000, 'lines': [{'description': 'TMT bars', 'quantity': 100, 'unit': 'T'}]},
    {'title': 'Cement', 'bidMode': 'lot', 'startPrice': 5000000, 'lines': [{'description': 'OPC 53', 'quantity': 1000, 'unit': 'Bags'}]}]}, headers=H).status_code == 200
assert buyer.post(B + f"/api/staff/sourcing/events/{e['id']}/submit", headers=H).json()['status'] == 'APPROVED'
vids = []
for i in range(50):
    r = buyer.post(B + f"/api/staff/sourcing/events/{e['id']}/outside-bidders", json={'name': f'Bidder Co {i}', 'vendorType': 'IMPORT', 'contactFirstName': 'B', 'contactLastName': str(i), 'contactEmail': f'bidder{i}@load.test', 'contactMobile': '+44 7700 900123'}, headers=H).json()
    vids.append([b for b in r['bidders'] if b['vendor']['name'] == f'Bidder Co {i}'][0]['vendor']['id'])
assert buyer.post(B + f"/api/staff/sourcing/events/{e['id']}/invitations", headers=H).status_code == 200
def bidder(vid):
    c, s = vendor_session(psql(f"select invite_token from vendors where id='{vid}'"))
    s.post(B + '/api/vendor/bidder-registration', json={'supplies': 'Steel'}, headers=H)
    assert s.post(B + f"/api/vendor/events/{e['id']}/response", json={'accept': True, 'noConflict': True}, headers=H).status_code == 200
    return c
with ThreadPoolExecutor(8) as ex: bidders = list(ex.map(bidder, vids))
lots = requests.get(B + f"/api/vendor/events/{e['id']}/live", cookies={'vg_v': bidders[0]}, headers=H).json()['lots']
json.dump({'staff': staff, 'suppliers': suppliers, 'bidders': bidders, 'event': e['id'], 'lots': [l['id'] for l in lots],
           'vendorIds': psql("select id from vendors where code like 'VND-L%' order by code limit 300").split('\n')}, open(os.path.join(os.path.dirname(__file__), 'tokens.json'), 'w'))
print('staff', len(staff), 'suppliers', len(suppliers), 'bidders', len(bidders), 'event', e['number'])
