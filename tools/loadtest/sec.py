"""Targeted security checks against the production-mode server on :4801 (demo data)."""
import hashlib, io, json, re, secrets, statistics, subprocess, time, uuid, requests
B = 'http://localhost:4801'; H = {'X-Requested-With': 'fetch'}
DB = ['psql', '-h', 'localhost', '-U', 'vendor', '-d', 'vendor_onboarding_manual_e2e', '-tAc']
def psql(q): return subprocess.check_output(DB + [q], env={'PGPASSWORD': 'vendor', 'PATH': '/usr/bin:/bin'}).decode().strip()
ACME = psql("select id from tenants where slug='acme'")
R = []  # (area, check, ok, detail)
def rec(area, check, ok, detail=''): R.append((area, check, bool(ok), str(detail)[:200])); print('PASS' if ok else 'FAIL', area, '|', check, '|', str(detail)[:160])
ipn = [0]
import random
IPB = random.randint(1, 250)
def ip(): ipn[0] += 1; return f'172.{IPB}.{ipn[0] // 250}.{ipn[0] % 250}'
def hx(extra=None): return {**H, 'X-Forwarded-For': ip(), **(extra or {})}
def staff(email):
    # Cookies are Secure in production; this test talks plain http, so copy the cookie into a non-secure one.
    s = requests.Session(); r = s.post(B + '/api/auth/login', json={'workspace': 'acme', 'email': email, 'password': 'Demo@12345'}, headers=hx())
    tok = s.cookies.get('vg_s'); s.cookies.clear(); s.cookies.set('vg_s', tok); return s, r
def vendor_session(vendor_id):
    tok = secrets.token_hex(24)
    psql(f"insert into sessions (id, token_hash, kind, tenant_id, vendor_id, expires_at, contact_email) values ('{uuid.uuid4()}', '{hashlib.sha256(tok.encode()).hexdigest()}', 'VENDOR', '{ACME}', '{vendor_id}', now() + interval '2 hours', (select contact_email from vendors where id='{vendor_id}'))")
    s = requests.Session(); s.cookies.set('vg_v', tok); return s

# ---------- 1. Headers and cookies
admin, r = staff('admin@acme.test')
h = {k.lower(): v for k, v in r.headers.items()}
setc = r.headers.get('set-cookie', '')
rec('Headers', 'Session cookie HttpOnly, Secure, SameSite', 'httponly' in setc.lower() and 'secure' in setc.lower() and 'samesite=lax' in setc.lower(), setc.split(';', 1)[1][:120])
page = requests.get(B + '/login')
ph = {k.lower(): v for k, v in page.headers.items()}
rec('Headers', 'Content-Security-Policy on pages', 'content-security-policy' in ph, ph.get('content-security-policy', '')[:150])
rec('Headers', "CSP blocks framing (frame-ancestors 'none'/'self')", re.search(r"frame-ancestors '(none|self)'", ph.get('content-security-policy', '')) or ph.get('x-frame-options'), ph.get('x-frame-options'))
rec('Headers', 'Strict-Transport-Security', 'strict-transport-security' in ph, ph.get('strict-transport-security'))
rec('Headers', 'X-Content-Type-Options nosniff', ph.get('x-content-type-options') == 'nosniff')
rec('Headers', 'Referrer-Policy', 'referrer-policy' in ph, ph.get('referrer-policy'))
rec('Headers', 'No X-Powered-By', 'x-powered-by' not in ph and 'x-powered-by' not in h)
rec('Headers', 'API responses not cached (Cache-Control no-store)', 'no-store' in h.get('cache-control', ''), h.get('cache-control'))
tr = requests.request('TRACE', B + '/api/health'); rec('Headers', 'TRACE not echoed', tr.status_code in (403, 404, 405, 400) and 'TRACE' not in tr.text, tr.status_code)
cors = requests.get(B + '/api/auth/me', headers={'Origin': 'https://evil.example'}, cookies=admin.cookies)
rec('CSRF/CORS', 'No CORS allowance for other sites', 'access-control-allow-origin' not in {k.lower() for k in cors.headers}, cors.headers.get('access-control-allow-origin'))

# ---------- 2. CSRF
r = admin.post(B + '/api/admin/sourcing/approval', json={'levels': []}, headers={'X-Forwarded-For': ip()})
rec('CSRF/CORS', 'State-changing request without X-Requested-With is refused', r.status_code == 403, r.status_code)
r = admin.post(B + '/api/auth/logout', data='x=1', headers={'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip()})
rec('CSRF/CORS', 'Form-encoded cross-site POST refused', r.status_code == 403, r.status_code)

# ---------- 3. Login: enumeration, brute force, lockout
def attempt(email, pw, xff):
    t = time.perf_counter(); r = requests.post(B + '/api/auth/login', json={'workspace': 'acme', 'email': email, 'password': pw}, headers={**H, 'X-Forwarded-For': xff}); return r, time.perf_counter() - t
a, _ = attempt('nobody@acme.test', 'Wrong@12345', ip()); b, _ = attempt('buyer@acme.test', 'Wrong@12345', ip())
rec('Authentication', 'Same error for unknown user and wrong password', a.status_code == b.status_code and a.json().get('error') == b.json().get('error'), f"{a.status_code} {a.text[:60]} / {b.status_code} {b.text[:60]}")
tu = [attempt('nobody%d@acme.test' % i, 'Wrong@12345', ip())[1] for i in range(6)]; tk = [attempt('vendoradmin@acme.test', 'Wrong@12345', ip())[1] for i in range(6)]
rec('Authentication', 'No timing difference between unknown and known users', abs(statistics.median(tu) - statistics.median(tk)) < 0.08, f'unknown {statistics.median(tu):.3f}s known {statistics.median(tk):.3f}s')
xff = ip(); codes = [attempt('compliance@acme.test', f'Wrong{i}@x', xff)[0].status_code for i in range(25)]
rec('Authentication', 'Login brute force rate-limited per IP (429)', 429 in codes, codes[-6:])
locked = attempt('compliance@acme.test', 'Demo@12345', ip())[0]
rec('Authentication', 'Account locks after repeated wrong passwords', locked.status_code in (401, 423, 429) and re.search('lock|too many failed', locked.text.lower()), locked.text[:100])
psql("update users set failed_logins=0, locked_until=null where email='compliance@acme.test'")
# rotating IPs does not get around the per-account lock (already shown) — and X-Forwarded-For spoofing only works because TRUST_PROXY=true without a real proxy here.

# ---------- 4. Session handling
s, _ = staff('buyer@acme.test'); tok = s.cookies.get('vg_s')
s.post(B + '/api/auth/logout', headers=hx())
r = requests.get(B + '/api/auth/me', cookies={'vg_s': tok}, headers=hx())
rec('Sessions', 'Logout revokes the session on the server', r.status_code == 401, r.status_code)
r = requests.get(B + '/api/auth/me', cookies={'vg_s': 'x' * 48}, headers=hx())
rec('Sessions', 'Forged session token rejected', r.status_code == 401, r.status_code)

# ---------- 5. Supplier sign-in codes
token = psql(f"select invite_token from vendors where tenant_id='{ACME}' and name like 'Layman%'")
xff = ip(); rq = requests.post(B + '/api/vendor-auth/request-otp', json={'token': token}, headers={**H, 'X-Forwarded-For': xff})
rec('Supplier sign-in', 'Code not shown in production', 'devOtp' not in rq.text, rq.text[:80])
codes = []
for i in range(8):
    r = requests.post(B + '/api/vendor-auth/verify-otp', json={'token': token, 'code': f'{100000 + i}'}, headers={**H, 'X-Forwarded-For': ip()}); codes.append(r.status_code)
rec('Supplier sign-in', 'Code guessing is cut off after a few wrong codes', any(c in (429, 423) for c in codes) or 'request a new' in r.text.lower(), f'{codes} {r.text[:90]}')
r = requests.post(B + '/api/vendor-auth/verify-otp', json={'token': 'nope' * 8, 'code': '123456'}, headers=hx())
rec('Supplier sign-in', 'Invalid invite token gives no detail', r.status_code in (400, 401, 404), f'{r.status_code} {r.text[:80]}')

# ---------- 6. Injection and input handling
for q in ["'", "' OR '1'='1", "%' --", "\\", '%_%', "a') union select 1--", '\u0000']:
    r = admin.get(B + '/api/staff/vendors', params={'q': q}, headers=hx())
    if r.status_code >= 500: rec('Injection', f'SQL-like search input {q!r}', False, r.status_code); break
else: rec('Injection', 'SQL-like search input handled (no errors, parameterised)', True)
r = admin.get(B + '/api/staff/vendors', params={'q': "' OR '1'='1"}, headers=hx())
rec('Injection', "Search \"' OR '1'='1\" returns nothing (not all rows)", r.ok and r.json()['total'] == 0, r.json().get('total'))
r = admin.get(B + '/api/ask', params={'q': 'suppliers; drop table vendors'}, headers=hx())
rec('Injection', 'Ask (plain-words search) does not run text as SQL', r.status_code < 500 and psql("select count(*) from vendors") != '0', r.status_code)
r = admin.post(B + '/api/auth/login', data='{bad json', headers=hx({'Content-Type': 'application/json'}))
rec('Input', 'Malformed JSON → 400, not 500', r.status_code == 400, r.status_code)
r = admin.post(B + '/api/auth/login', data='{"a":"' + 'x' * 1_200_000 + '"}', headers=hx({'Content-Type': 'application/json'}))
rec('Input', 'Oversized body → 413, not 500', r.status_code == 413, r.status_code)
r = admin.patch(B + '/api/admin/tenant', json={}, headers=hx())
rec('Input', 'Empty update → 400, not 500', r.status_code == 400, r.status_code)
r = admin.patch(B + '/api/staff/vendors/x', json={'__proto__': {'admin': True}}, headers=hx())
rec('Input', 'Prototype-pollution body has no effect', r.status_code < 500 and admin.get(B + '/api/auth/me', headers=hx()).json().get('admin') is None, r.status_code)

# ---------- 7. Uploads
sund = psql(f"select id from vendors where tenant_id='{ACME}' and name like 'Layman%'")  # still editable
psql(f"update vendors set consent_at=now(), consent_version=(select max(consent_version) from vendors where tenant_id='{ACME}') where id='{sund}'")
v = vendor_session(sund)
html = b'<html><script>alert(document.cookie)</script></html>'
r = v.post(B + '/api/vendor/documents', files={'file': ('cheque.pdf', html, 'application/pdf')}, data={'docType': 'CANCELLED_CHEQUE'}, headers=hx())
rec('Uploads', 'HTML disguised as PDF is refused', r.status_code in (400, 415, 409), f'{r.status_code} {r.text[:100]}')
r = v.post(B + '/api/vendor/documents', files={'file': ('x.svg', b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'image/svg+xml')}, data={'docType': 'CANCELLED_CHEQUE'}, headers=hx())
rec('Uploads', 'SVG (can carry script) is refused', r.status_code in (400, 415, 409), f'{r.status_code} {r.text[:100]}')
pdf = b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'
r = v.post(B + '/api/vendor/documents', files={'file': ('../../../../etc/passwd.pdf', pdf, 'application/pdf')}, data={'docType': 'CANCELLED_CHEQUE'}, headers=hx())
ok = r.status_code < 300
doc = r.json().get('document', r.json()) if ok else {}
stored = psql(f"select storage_path from documents where vendor_id='{sund}' order by uploaded_at desc limit 1") if ok else ''
rec('Uploads', 'Path in file name ignored when storing', ok and '..' not in stored and '/etc/' not in stored, f'{r.status_code} key={stored}')
if ok:
    did = psql(f"select id from documents where vendor_id='{sund}' order by uploaded_at desc limit 1")
    d = v.get(B + f'/api/documents/{did}', headers=hx())
    dh = {k.lower(): x for k, x in d.headers.items()}
    rec('Uploads', 'Downloads sent with nosniff and a safe disposition', dh.get('x-content-type-options') == 'nosniff' and ('attachment' in dh.get('content-disposition', '') or dh.get('content-type', '').startswith('application/pdf')), f"{d.status_code} {dh.get('content-type')} {dh.get('content-disposition')}")
r = v.post(B + '/api/vendor/documents', files={'file': ('big.pdf', b'%PDF-1.4\n' + b'0' * (6 * 1024 * 1024), 'application/pdf')}, data={'docType': 'CANCELLED_CHEQUE'}, headers=hx())
rec('Uploads', 'Files over the size limit refused', r.status_code == 400, f'{r.status_code} {r.text[:80]}')

# ---------- 8. SSRF through integration URLs
for url in ['http://169.254.169.254/latest/meta-data/', 'http://localhost:4801/api/health', 'http://10.0.0.5/hook', 'http://[::1]/x', 'http://0x7f000001/']:
    r = admin.put(B + '/api/admin/erp', json={'kind': 'webhook', 'testMode': False, 'autoPush': False, 'config': {'url': url}, 'secrets': {'signingSecret': 'x' * 24}}, headers=hx())
    t = admin.post(B + '/api/admin/erp/test', headers=hx()) if r.ok else None
    blocked = (not r.ok) or (t is not None and ('private' in t.text.lower() or 'not allowed' in t.text.lower() or 'local' in t.text.lower() or t.status_code >= 400))
    rec('SSRF', f'ERP webhook to internal address {url} refused', blocked, f'{r.status_code} {r.text[:80]} / {t.status_code if t is not None else "-"} {t.text[:100] if t is not None else ""}')
admin.put(B + '/api/admin/erp', json={'kind': 'none', 'testMode': False, 'autoPush': False, 'config': {}, 'secrets': {}}, headers=hx())

# ---------- 9. Mass assignment / privilege
viewer, _ = staff('farah@acme.test')
r = viewer.patch(B + '/api/admin/users/' + psql("select id from users where email='farah@acme.test'"), json={'roleKeys': ['ADMIN']}, headers=hx())
rec('Privilege', 'Viewer cannot give themselves Administrator', r.status_code in (401, 403, 404), r.status_code)
r = v.put(B + '/api/vendor/profile/basic', json={'status': 'APPROVED', 'tenantId': 'x', 'riskBand': 'LOW', 'address': 'A'}, headers=hx())
st = psql(f"select status from vendors where id='{sund}'")
rec('Privilege', 'Supplier cannot set their own status / workspace', st != 'APPROVED', f'{r.status_code} status={st}')

# ---------- 10. Sealed bids and bidder privacy
ev = psql(f"select id from sourcing_events where tenant_id='{ACME}' and format='rfq'")
loser = psql(f"select v.id from vendors v join sourcing_bidders b on b.vendor_id=v.id where b.event_id='{ev}' and v.name like 'Gulf%'")
g = vendor_session(loser)
txt = g.get(B + f'/api/vendor/events/{ev}', headers=hx()).text + g.get(B + f'/api/vendor/events/{ev}/offer', headers=hx()).text
rec('Sourcing', "A bidder never sees other bidders' names, prices or the estimate", not re.search(r'Nordic|Valvex|Precision|1800000|15,?81,?000|1581000', txt), re.findall(r'Nordic|Valvex|Precision|1800000', txt)[:3])
other = psql(f"select id from sourcing_events where tenant_id='{ACME}' and format='reverse' limit 1")
r = g.get(B + f'/api/vendor/events/{other}', headers=hx())
rec('Sourcing', 'A supplier cannot open an event they were not invited to', r.status_code == 404, r.status_code)
r = g.post(B + f'/api/vendor/events/{other}/bids', json={'lotId': 'x', 'amount': 1}, headers=hx())
rec('Sourcing', 'A supplier cannot bid in an auction they were not invited to', r.status_code in (403, 404), r.status_code)

# ---------- 11. Spreadsheet formula injection in exports
psql(f"update vendors set name='=HYPERLINK(\"http://evil.example\",\"Click\")' where id=(select id from vendors where tenant_id='{ACME}' and name like 'Precision%')")
x = admin.get(B + '/api/reports/vendor-register', params={'format': 'xlsx'}, headers=hx())
import zipfile
cell = ''
try:
    z = zipfile.ZipFile(io.BytesIO(x.content)); xml = ''.join(z.read(n).decode('utf8', 'ignore') for n in z.namelist() if 'sheet' in n or 'sharedStrings' in n)
    cell = 'formula' if '<f>' in xml and 'HYPERLINK' in xml else ('text' if 'HYPERLINK' in xml else 'absent')
except Exception as e: cell = f'not xlsx ({x.status_code} {x.headers.get("content-type")})'
rec('Exports', 'Supplier-typed text starting with = is not a live formula in Excel exports', cell == 'text', cell)
c = admin.get(B + '/api/staff/erp/export.csv', headers=hx())
line = next((l for l in c.text.splitlines() if 'HYPERLINK' in l), '')
rec('Exports', 'CSV export neutralises formulas (leading = + - @)', not line or re.search(r"(^|,)\"?'=HYPERLINK", line) is not None, line[:120] or f'{c.status_code} not in export')
psql(f"update vendors set name='Precision Valves Pvt Ltd' where name like '=HYPERLINK%'")

# ---------- 12. Information disclosure
r = requests.get(B + '/api/staff/vendors/%ff', cookies=admin.cookies, headers=hx())
rec('Disclosure', 'Errors never include stack traces', 'at ' not in r.text and 'node_modules' not in r.text, f'{r.status_code} {r.text[:80]}')
r = requests.get(B + '/api/meta/mailbox', cookies=admin.cookies, headers=hx())
rec('Disclosure', 'Developer mailbox off in production', r.status_code in (403, 404), r.status_code)
r = requests.get(B + '/.env'); r2 = requests.get(B + '/../server/.env')
rec('Disclosure', 'No source / .env files served', '.env' not in r.text and 'DATABASE_URL' not in r.text and 'DATABASE_URL' not in r2.text, f'{r.status_code}')
r = requests.get(B + '/index.js.map'); m = re.findall(r'/assets/[^"]+\.js', requests.get(B + '/login').text)
sm = requests.get(B + m[0] + '.map') if m else None
rec('Disclosure', 'No source maps published', sm is None or sm.status_code != 200 or 'sourcesContent' not in sm.text, sm.status_code if sm is not None else '-')

# ---------- 13. Contracts: review links, other party's access, e-signature callbacks, reading, exports
import contracts_fixture
cA, cB = contracts_fixture.ensure(B, psql, ACME)
link = secrets.token_hex(24)
psql(f"update contract_reviewers set link_hash='{hashlib.sha256(link.encode()).hexdigest()}', session_hash=null, code_hash=null, codes_sent=0, wrong_codes=0, code_attempts=0, revoked_at=null where contract_id='{cA}'")
r = requests.get(B + f'/api/review/link/{secrets.token_hex(24)}', headers=hx())
rec('Contracts', 'An unknown review link answers 404', r.status_code == 404, r.status_code)
r = requests.post(B + f'/api/review/link/{link}/code', headers=hx())
rec('Contracts', 'A review sign-in code is emailed, never returned in production', r.status_code == 200 and not re.search(r'\b\d{6}\b', r.text), f'{r.status_code} {r.text[:80]}')
codes = [requests.post(B + f'/api/review/link/{link}/verify', json={'code': f'{n:06d}'}, headers=hx()).status_code for n in range(7)]
r = requests.post(B + f'/api/review/link/{link}/verify', json={'code': '999999'}, headers=hx())
rec('Contracts', 'Wrong review codes are limited (the code stops working after 5 tries)', codes[:5].count(200) == 0 and codes[5:] != [200, 200] and r.status_code != 200, codes)
rtok = secrets.token_hex(24)
psql(f"update contract_reviewers set session_hash='{hashlib.sha256(rtok.encode()).hexdigest()}', session_expires_at=now()+interval '1 hour' where contract_id='{cA}'")
rv = requests.Session(); rv.cookies.set('vg_c', rtok)
fileB = psql(f"select id from contract_files where contract_id='{cB}' limit 1")
r = rv.get(B + f'/api/review/session/files/{fileB}', headers=hx())
rec('Contracts', "A reviewer cannot download another contract's file", r.status_code == 404, r.status_code)
txt = rv.get(B + '/api/review/session', headers=hx()).text
rec('Contracts', 'The review view shows no internal notes, approvers or other contracts', cB not in txt and 'internal' not in txt.lower() and 'Authz NDA 1' not in txt, re.findall(r'internal|Authz NDA 1', txt)[:3])
r = rv.get(B + f'/api/staff/contracts/{cA}', headers=hx())
rec('Contracts', 'A reviewer session is not a staff session', r.status_code in (401, 403), r.status_code)
r = requests.post(B + f'/api/esign/webhook/{ACME}/docusign', data=json.dumps({'event': 'envelope-completed', 'data': {'envelopeId': 'x'}}), headers=hx({'Content-Type': 'application/json', 'X-DocuSign-Signature-1': 'bm90LXJpZ2h0'}))
rec('Contracts', 'An e-signature webhook with a wrong signature changes nothing', r.status_code in (200, 401, 404) and 'completed' not in r.text, f'{r.status_code} {r.text[:60]}')
r = requests.get(B + f'/api/esign/return/{uuid.uuid4()}/{secrets.token_hex(16)}', headers=hx(), allow_redirects=False)
rec('Contracts', 'A made-up signing return link does not sign anything', r.status_code in (303, 400, 404) and 'signed' not in (r.headers.get('location') or ''), f"{r.status_code} {r.headers.get('location')}")
r = requests.get(B + f'/api/esign/webhook/{ACME}/adobe', headers=hx({'X-AdobeSign-ClientId': 'abc'}))
rec('Contracts', 'Adobe webhook check echoes only its client id header', r.headers.get('X-AdobeSign-ClientId') == 'abc' and r.status_code == 200, r.status_code)
# Reading: a file that is not really Word, and a zip bomb disguised as Word, give a clean 400 — never a crash.
bomb = io.BytesIO(); zf = zipfile.ZipFile(bomb, 'w', zipfile.ZIP_DEFLATED); zf.writestr('word/document.xml', '<w:t>' + 'A' * 60_000_000 + '</w:t>'); zf.close()
for name, data in [('fake.docx', b'MZ\x90\x00 not a zip at all'), ('bomb.docx', bomb.getvalue())]:
    up = admin.post(B + f'/api/staff/contracts/{cB}/files', data={'kind': 'OTHER'}, files={'file': (name, data, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}, headers=hx())
    fid = next((f['id'] for f in up.json().get('files', []) if f['fileName'] == name), None) if up.status_code < 300 else None
    rr = admin.post(B + f'/api/staff/contracts/{cB}/files/{fid}/read', headers=hx()) if fid else up
    rec('Contracts', f'Reading {name} is refused cleanly (no 5xx, no hang)', rr.status_code < 500, f'upload {up.status_code} read {rr.status_code} {rr.text[:80]}')
r = admin.get(B + f'/api/staff/contracts/{cB}', headers=hx()).json()
sent = [x['sentToAi'] for x in r.get('reading', {}).get('readings', [])]
rec('Contracts', 'Without an AI provider nothing is sent (readings are local)', all(x is None for x in sent), sent[:2])
tax, _ = staff('tax@acme.test')
r = tax.get(B + '/api/staff/contracts/reports', headers=hx())
rec('Contracts', 'Contract reports need the contracts permission', r.status_code == 403, r.status_code)
psql(f"update parties set name='=HYPERLINK(\"http://evil.example\",\"x\")' where name='Authz Customer 0'")
psql(f"update contracts set status='ACTIVE', value=1000, signed_date=current_date where id='{cA}'")
time.sleep(61)  # reports are cached for a minute
x = admin.get(B + '/api/staff/contracts/reports.xlsx', headers=hx())
try:
    z = zipfile.ZipFile(io.BytesIO(x.content)); xml = ''.join(z.read(n).decode('utf8', 'ignore') for n in z.namelist() if 'sheet' in n or 'sharedStrings' in n)
    cell = 'formula' if '<f>' in xml and 'HYPERLINK' in xml else ('text' if 'HYPERLINK' in xml else 'absent')
except Exception as e: cell = f'not xlsx ({x.status_code})'
rec('Exports', 'Party names starting with = are text in the contract report export', cell == 'text', cell)
psql(f"update parties set name='Authz Customer 0' where name like '=HYPERLINK%'")
psql(f"update contracts set status='WITH_PARTY', value=null, signed_date=null where id='{cA}'")

json.dump(R, open('sec-results.json', 'w'))
print('\n', sum(1 for x in R if x[2]), 'passed,', sum(1 for x in R if not x[2]), 'failed')
