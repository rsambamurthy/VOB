"""Contracts load data (run after setup.py, against the same throw-away server on port 4800):
3,000 parties, 5,000 contracts across every stage, 2,500 obligations (on the active ones), 20 contracts with the other party
(one reviewer session each), and a Word contract to read. Adds 'contracts', 'contractFiles' and 'reviewers' to tokens.json."""
import hashlib, io, json, os, secrets, subprocess, zipfile, requests
B = 'http://localhost:4800'; H = {'X-Requested-With': 'fetch'}
DB = ['psql', '-h', 'localhost', '-U', 'vendor', '-d', 'vendor_onboarding_load_e2e', '-tAc']
def psql(q): return subprocess.check_output(DB + [q], env={'PGPASSWORD': 'vendor', 'PATH': '/usr/bin:/bin'}).decode().strip()
HERE = os.path.dirname(os.path.abspath(__file__))

psql("update tenants set limits = coalesce(limits,'{}'::jsonb) || jsonb_build_object('features', coalesce(limits->'features','{}'::jsonb) || '{\"contracts\": true, \"ai\": true}') where slug='acme'")
adm = requests.Session(); assert adm.post(B + '/api/auth/login', json={'workspace': 'acme', 'email': 'admin@acme.test', 'password': 'Demo@12345'}, headers=H).status_code == 200
types = {k: True for k in ['nda', 'msa', 'sow', 'service', 'purchase', 'sales', 'supply']}
r = adm.put(B + '/api/admin/contracts', json={'enabled': True, 'types': types, 'features': {'internalApproval': False, 'counterpartyPortal': True, 'obligations': True, 'renewalAlerts': True, 'aiExtraction': True, 'customerContracts': True}}, headers=H)
assert r.status_code == 200, r.text

# 20 NDAs drafted from the library and sent to the other party — one reviewer each.
reviewers, live = [], []
for i in range(20):
    p = adm.post(B + '/api/staff/parties', json={'kind': 'CUSTOMER', 'name': f'Review Customer {i}', 'country': 'IN', 'contacts': [{'name': f'Reviewer {i}', 'email': f'rev{i}@load.test', 'signatory': True}]}, headers=H).json()['party']
    c = adm.post(B + '/api/staff/contracts', json={'title': f'NDA {i}', 'direction': 'SELL', 'type': 'nda', 'partyId': p['id'], 'startDate': '2026-12-01', 'endDate': '2028-11-30'}, headers=H).json()
    tpl = next(t for t in c['drafting']['templates'] if t['name'] == 'Mutual non-disclosure agreement')
    cid = c['contract']['id']
    adm.post(B + f'/api/staff/contracts/{cid}/draft', json={'templateId': tpl['id']}, headers=H)
    assert adm.post(B + f'/api/staff/contracts/{cid}/document', headers=H).status_code == 200
    s = adm.post(B + f'/api/staff/contracts/{cid}/share', json={'people': [{'name': f'Reviewer {i}', 'email': f'rev{i}@load.test'}]}, headers=H)
    assert s.status_code == 200, s.text
    tok = secrets.token_hex(24)  # a signed-in reviewer session, as after link + code
    psql(f"update contract_reviewers set session_hash='{hashlib.sha256(tok.encode()).hexdigest()}', session_expires_at=now()+interval '8 hours' where contract_id='{cid}'")
    reviewers.append(tok); live.append(cid)

# One supplier contract made through the API, then copied in SQL for volume.
v = psql("select id from vendors where code='VND-00001' and tenant_id=(select id from tenants where slug='acme')")
p = adm.post(B + '/api/staff/parties/from-supplier', json={'vendorId': v}, headers=H).json()['party']
base = adm.post(B + '/api/staff/contracts', json={'title': 'Base AMC', 'direction': 'BUY', 'type': 'service', 'partyId': p['id'], 'value': 480000, 'startDate': '2026-04-01', 'endDate': '2027-03-31'}, headers=H).json()['contract']
psql(f"""DO $$ DECLARE pr parties; c contracts; i int; pids text[]; BEGIN
SELECT * INTO pr FROM parties WHERE id='{p['id']}';
FOR i IN 1..3000 LOOP
  pr.id:=gen_random_uuid(); pr.code:=(CASE WHEN i%4=0 THEN 'CUS-L' ELSE 'SUP-L' END)||lpad(i::text,5,'0'); pr.kind:=CASE WHEN i%4=0 THEN 'CUSTOMER' ELSE 'SUPPLIER' END;
  pr.name:='Load Party '||i; pr.vendor_id:=NULL; INSERT INTO parties SELECT pr.*; END LOOP;
SELECT array_agg(id) INTO pids FROM parties WHERE code LIKE '%-L%';
SELECT * INTO c FROM contracts WHERE id='{base['id']}';
FOR i IN 1..5000 LOOP
  c.id:=gen_random_uuid(); c.number:='LD-'||lpad(i::text,5,'0'); c.title:='Load contract '||i; c.party_id:=pids[1+i%3000];
  c.direction:=CASE WHEN i%4=0 THEN 'SELL' ELSE 'BUY' END; c.type:=(array['service','purchase','supply','msa','sow'])[1+i%5];
  IF c.direction='SELL' THEN c.type:='sales'; END IF;
  c.status:=(array['ACTIVE','ACTIVE','ACTIVE','DRAFT','EXPIRED','ACTIVE','TERMINATED','APPROVED'])[1+i%8];
  c.value:=(10000+(i*7919)%9000000); c.start_date:=(date '2025-01-01' + (i%600)); c.end_date:=(date '2025-01-01' + (i%600) + 365 + (i%400));
  c.signed_date:=CASE WHEN c.status IN ('ACTIVE','EXPIRED','TERMINATED') THEN c.start_date - 5 ELSE NULL END; c.created_at:=c.start_date - 30;
  INSERT INTO contracts SELECT c.*; END LOOP; END $$;""")
psql(f"""insert into contract_obligations (id, tenant_id, contract_id, title, kind, side, due_date, created_by_name, status, done_at)
  select gen_random_uuid(), tenant_id, id, 'Quarterly service report', 'REPORT', 'PARTY', (date '2026-06-01' + (row_number() over ())::int % 300), 'Load',
  case when random() < .4 then 'DONE' else 'OPEN' end, case when random() < .4 then now() - interval '10 days' end
  from contracts where number like 'LD-%' and status='ACTIVE' limit 2500""")

# A Word contract on the base contract, for the reading endpoint.
def docx(text):
    body = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{t}</w:t></w:r></w:p>' for t in text)
    b = io.BytesIO(); z = zipfile.ZipFile(b, 'w')
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', f'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')
    z.close(); return b.getvalue()
text = ['ANNUAL MAINTENANCE CONTRACT', 'This Agreement is made on 15th March 2026 between the Company and the Contractor.',
        '1. Term. This Agreement commences on 1 April 2026 and continues until 31 March 2027. It renews automatically for further periods of twelve (12) months unless either Party gives thirty (30) days prior written notice.',
        '2. Price. The total consideration is INR 25,45,000 payable quarterly.', '3. Governing law. This Agreement is governed by the laws of India.']
f = adm.post(B + f"/api/staff/contracts/{base['id']}/files", data={'kind': 'DRAFT'}, files={'file': ('amc.docx', docx(text), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')}, headers=H)
assert f.status_code in (200, 201), f.text
fileId = f.json()['files'][0]['id']

T = json.load(open(os.path.join(HERE, 'tokens.json')))
T.update({'contracts': psql("select id from contracts where number like 'LD-%' order by random() limit 300").split('\n'), 'reviewers': reviewers,
          'readContract': base['id'], 'readFile': fileId})
json.dump(T, open(os.path.join(HERE, 'tokens.json'), 'w'))
print('parties', psql("select count(*) from parties"), 'contracts', psql("select count(*) from contracts"), 'obligations', psql("select count(*) from contract_obligations"), 'reviewers', len(reviewers))
