"""Authorization sweep over every API route: anonymous, other workspace, supplier-on-staff, low-privilege staff, other supplier."""
import hashlib, json, re, secrets, subprocess, uuid, requests
B = 'http://localhost:4801'
DB = ['psql', '-h', 'localhost', '-U', 'vendor', '-d', 'vendor_onboarding_manual_e2e', '-tAc']
def psql(q): return subprocess.check_output(DB + [q], env={'PGPASSWORD': 'vendor', 'PATH': '/usr/bin:/bin'}).decode().strip()
ACME = psql("select id from tenants where slug='acme'"); GLOBEX = psql("select id from tenants where slug='globex'")
def one(q): return psql(q).split('\n')[0]
n = [0]
def session(kind, tenant, user=None, vendor=None, email=None):
    tok = secrets.token_hex(24); n[0] += 1
    q = lambda x: f"'{x}'" if x else 'null'
    psql(f"insert into sessions (id, token_hash, kind, tenant_id, user_id, vendor_id, expires_at, contact_email) values ('{uuid.uuid4()}', '{hashlib.sha256(tok.encode()).hexdigest()}', '{kind}', '{tenant}', {q(user)}, {q(vendor)}, now() + interval '2 hours', {q(email)})")
    return {'vg_s' if kind == 'STAFF' else 'vg_v': tok}
uid = lambda email: one(f"select id from users where email='{email}'")
S = {
    'anon': {},
    'globexAdmin': session('STAFF', GLOBEX, uid('admin@globex.test')),
    'acmeViewer': session('STAFF', ACME, uid('farah@acme.test')),
    'acmeTax': session('STAFF', ACME, uid('tax@acme.test')),
}
precision = one(f"select id from vendors where tenant_id='{ACME}' and name like 'Precision%'")
sundaram = one(f"select id from vendors where tenant_id='{ACME}' and name like 'Sundaram%'")
S['supplierSundaram'] = session('VENDOR', ACME, vendor=sundaram, email=one(f"select contact_email from vendors where id='{sundaram}'"))
S['supplierPrecision'] = session('VENDOR', ACME, vendor=precision, email=one(f"select contact_email from vendors where id='{precision}'"))
# An outside bidder who lost the RFQ — must never see other bidders' data.
loser = one(f"select v.id from vendors v join sourcing_bidders b on b.vendor_id=v.id where v.tenant_id='{ACME}' and v.name like 'Gulf Valve%'")
S['bidderGulf'] = session('VENDOR', ACME, vendor=loser, email=one(f"select contact_email from vendors where id='{loser}'"))

ids = {
    'vendor': precision, 'doc': one(f"select id from documents where vendor_id='{precision}'"),
    'event': one(f"select id from sourcing_events where tenant_id='{ACME}' and format='rfq'"),
    'po': one(f"select id from purchase_orders where tenant_id='{ACME}'"), 'user': uid('buyer@acme.test'),
    'role': one(f"select id from roles where tenant_id='{ACME}' and key='BUYER'"), 'questionnaire': one(f"select id from questionnaires where tenant_id='{ACME}'"),
    'agreement': one(f"select id from agreements where tenant_id='{ACME}'"), 'action': one(f"select id from corrective_actions where tenant_id='{ACME}'"),
    'link': one(f"select id from registration_links where tenant_id='{ACME}'"), 'bid': one(f"select id from sourcing_bids where tenant_id='{ACME}'"),
}
ids['sundaramDoc'] = one(f"select id from documents where vendor_id='{sundaram}'")

# Contracts: two NDAs with the other party (made through the API if missing); a reviewer of the first one only.
import contracts_fixture
cA, cB = contracts_fixture.ensure(B, psql, ACME)
rtok = secrets.token_hex(24)
psql(f"update contract_reviewers set session_hash='{hashlib.sha256(rtok.encode()).hexdigest()}', session_expires_at=now()+interval '2 hours', revoked_at=null where contract_id='{cA}'")
S['reviewerA'] = {'vg_c': rtok}
ids.update({'contract': cB, 'contractFile': one(f"select id from contract_files where contract_id='{cB}'"), 'party': one(f"select party_id from contracts where id='{cB}'"),
            'clause': one(f"select id from contract_clauses where tenant_id='{ACME}'"), 'template': one(f"select id from contract_templates where tenant_id='{ACME}'"),
            'obligation': one(f"select id from contract_obligations where contract_id='{cB}'"), 'comment': one(f"select id from contract_comments where tenant_id='{ACME}'") or cB,
            'reading': one(f"select id from contract_readings where tenant_id='{ACME}'") or cB, 'suggestion': one(f"select id from contract_suggestions where tenant_id='{ACME}'") or cB, 'signature': one(f"select id from contract_signatures where tenant_id='{ACME}'") or cB})
def fill(path, who):
    # Pick the most likely id for each parameter from the path around it.
    def sub(m):
        seg = path[:m.start()].rstrip('/').split('/')[-1]
        key = {'vendors': 'vendor', 'documents': 'doc', 'events': 'event', 'orders': 'po', 'users': 'user', 'roles': 'role', 'questionnaires': 'questionnaire',
               'agreements': 'agreement', 'actions': 'action', 'registration-links': 'link', 'bids': 'bid', 'contracts': 'contract', 'parties': 'party',
               'files': 'contractFile', 'clauses': 'clause', 'templates': 'template', 'obligations': 'obligation', 'comments': 'comment', 'readings': 'reading',
               'return': 'signature', 'suggestions': 'suggestion'}.get(seg)
        if who == 'supplierSundaram' and seg == 'documents': return ids['doc']  # another supplier's document
        return ids.get(key) or ids['vendor']
    return re.sub(r':[A-Za-z]+', sub, path)

PUBLIC = re.compile(r'^/api/(health|auth/(login|forgot-password|reset-password|invite|accept-invite|mfa|sso|logout|me)|vendor-auth|apply|signup|meta|platform/auth|webhooks|help/public|scim|review/(link|sign-out)|esign/(webhook|return))')
routes = json.load(open('routes.json'))
findings = []
counts = {}
for r in routes:
    m, path = r.split(' ', 1)
    if not path.startswith('/api') or m == 'HEAD' or path.endswith('/logout') or 'sessions' in path or path.endswith('/revoke'): continue
    for who, cookie in S.items():
        if who == 'acmeViewer' and m == 'GET': continue  # viewers may read
        if who.startswith('supplier') and not path.startswith('/api/staff') and not path.startswith('/api/admin') and not path.startswith('/api/reports') and who != 'supplierSundaram': continue
        if who == 'supplierSundaram' and not (path.startswith('/api/vendor') or path.startswith('/api/documents') or path.startswith('/api/staff') or path.startswith('/api/admin')): continue
        if who == 'bidderGulf' and not path.startswith('/api/vendor/events'): continue
        if who == 'reviewerA' and not (path.startswith('/api/review') or path.startswith('/api/staff/contract') or path.startswith('/api/vendor/contracts')): continue
        if who == 'acmeTax' and not (path.startswith('/api/admin') or '/sourcing' in path): continue
        url = B + fill(path, who)
        try:
            resp = requests.request(m, url, cookies=cookie, json={} if m != 'GET' else None, headers={'X-Requested-With': 'fetch', 'X-Forwarded-For': f'10.{len(findings)%200}.{hash(who)%250}.9'}, timeout=15, allow_redirects=False)
        except Exception as e:
            findings.append((who, m, path, 'ERR', str(e)[:80])); continue
        counts[(who, resp.status_code)] = counts.get((who, resp.status_code), 0) + 1
        ok = resp.status_code < 300
        if who == 'anon' and ok and not PUBLIC.match(path): findings.append((who, m, path, resp.status_code, resp.text[:100]))
        elif who == 'globexAdmin' and ok and (ACME in resp.text or any(v and v in resp.text for v in ids.values())): findings.append((who, m, path, resp.status_code, resp.text[:100]))
        elif who == 'globexAdmin' and ok and m != 'GET' and re.search(r':[A-Za-z]+', path): findings.append((who, m, path, resp.status_code, resp.text[:100]))
        elif who in ('supplierPrecision',) and ok: findings.append((who, m, path, resp.status_code, resp.text[:100]))
        elif who == 'supplierSundaram' and ok and (path.startswith('/api/staff') or path.startswith('/api/admin') or precision in resp.text or ids['doc'] in resp.text): findings.append((who, m, path, resp.status_code, resp.text[:100]))
        elif who in ('acmeViewer', 'acmeTax') and ok: findings.append((who, m, path, resp.status_code, resp.text[:100]))
        elif resp.status_code >= 500: findings.append((who, m, path, resp.status_code, resp.text[:100]))
        elif who == 'reviewerA' and ok and (not path.startswith('/api/review') or cB in resp.text or ids['contractFile'] in resp.text): findings.append((who, m, path, resp.status_code, resp.text[:120]))
        elif who == 'bidderGulf' and ok and re.search(r'Nordic|Valvex|Precision|Hotel', resp.text): findings.append((who, m, path, resp.status_code, resp.text[:160]))
print('status counts', counts)
for f in findings: print(f)
