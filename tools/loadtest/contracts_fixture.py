"""Contracts data for sec.py and authz.py (demo data on :4801): two NDAs drafted from the library and sent to the
other party, each with an obligation. Made through the API once; returns the two contract ids (oldest first)."""
import requests
import random
H = {'X-Requested-With': 'fetch', 'X-Forwarded-For': f'10.250.{random.randint(1, 250)}.{random.randint(1, 250)}'}  # its own address, apart from the rate-limit tests

def admin_session(B):
    # Cookies are Secure in production; these tests talk plain http, so copy the cookie into a non-secure one.
    s = requests.Session(); s.post(B + '/api/auth/login', json={'workspace': 'acme', 'email': 'admin@acme.test', 'password': 'Demo@12345'}, headers=H)
    tok = s.cookies.get('vg_s'); s.cookies.clear(); s.cookies.set('vg_s', tok); return s

def ensure(B, psql, tenant):
    if int(psql(f"select count(distinct contract_id) from contract_reviewers where tenant_id='{tenant}'")) < 2:
        psql(f"""update tenants set limits = coalesce(limits,'{{}}'::jsonb) || jsonb_build_object('features', coalesce(limits->'features','{{}}'::jsonb) || '{{"contracts": true, "ai": true}}') where id='{tenant}'""")
        adm = admin_session(B)
        r = adm.put(B + '/api/admin/contracts', json={'enabled': True, 'types': {'nda': True, 'service': True}, 'features': {'internalApproval': False, 'counterpartyPortal': True, 'obligations': True, 'aiExtraction': True, 'customerContracts': True, 'esign': True}}, headers=H)
        assert r.status_code == 200, r.text
        for i in range(2):
            p = adm.post(B + '/api/staff/parties', json={'kind': 'CUSTOMER', 'name': f'Authz Customer {i}', 'country': 'IN', 'contacts': [{'name': 'Rhea Kapoor', 'email': f'authz{i}@example.test', 'signatory': True}]}, headers=H).json()
            assert 'party' in p, p
            p = p['party']
            c = adm.post(B + '/api/staff/contracts', json={'title': f'Authz NDA {i}', 'direction': 'SELL', 'type': 'nda', 'partyId': p['id']}, headers=H).json()
            cid = c['contract']['id']; tpl = next(t for t in c['drafting']['templates'] if t['name'] == 'Mutual non-disclosure agreement')
            adm.post(B + f'/api/staff/contracts/{cid}/draft', json={'templateId': tpl['id']}, headers=H)
            assert adm.post(B + f'/api/staff/contracts/{cid}/document', headers=H).status_code == 200
            assert adm.post(B + f'/api/staff/contracts/{cid}/share', json={'people': [{'name': 'Rhea Kapoor', 'email': f'authz{i}@example.test'}]}, headers=H).status_code == 200
            adm.post(B + f'/api/staff/contracts/{cid}/obligations', json={'title': 'Report', 'kind': 'REPORT', 'side': 'PARTY', 'dueDate': '2027-01-01'}, headers=H)
    return psql(f"select contract_id from contract_reviewers where tenant_id='{tenant}' group by contract_id order by min(created_at) limit 2").split('\n')
