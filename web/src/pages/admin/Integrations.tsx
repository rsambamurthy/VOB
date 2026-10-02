import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

interface Status {
  email: { provider: string; live: boolean; from: string; counts: Record<string, number>; lastFailures: { to: string; subject: string; error: string; createdAt: string }[] };
  sms: { provider: string; live: boolean; counts: Record<string, number> };
  storage: { driver: string; scan: string; bucket?: string };
  kyc: { provider: string; live: boolean };
  ai: { provider: string; live: boolean; model?: string; supports: string[]; enabledForWorkspace: boolean };
  jobs: { running: boolean };
  devMode: boolean;
}

const PROVIDER_NAMES: Record<string, string> = { test: 'Test mode', smtp: 'SMTP', sendgrid: 'SendGrid', msg91: 'MSG91', twilio: 'Twilio', local: 'Server disk', s3: 'S3-compatible', azure: 'Azure Blob', mock: 'Test mode', surepass: 'Surepass', anthropic: 'Claude (Anthropic)' };

function Card({ title, live, provider, children, env }: { title: string; live: boolean; provider: string; children: ReactNode; env: string }) {
  return (
    <section className="card pad int-card">
      <div className="row-between"><h3>{title}</h3><span className={`badge ${live ? 'badge-approved' : 'badge-under_review'}`}>{live ? 'Live' : 'Test mode'}</span></div>
      <p className="small"><strong>{PROVIDER_NAMES[provider] ?? provider}</strong></p>
      {children}
      {!live && <details className="small muted env-hint"><summary>How to go live</summary><pre className="code light">{env}</pre><p>Set these on the server (in <code>server/.env</code> locally, or your host’s environment variables) and restart.</p></details>}
    </section>
  );
}

export function Integrations() {
  const { me, refresh } = useSession();
  const [s, setS] = useState<Status>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [phone, setPhone] = useState('');
  const load = () => api<Status>('/admin/integrations').then(setS).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  if (!s || !me) return <div className="page"><div className="spinner" /></div>;
  const otp = me.tenant.settings.vendorOtpChannel ?? 'email';

  async function run(path: string, body: unknown, ok: (r: any) => string) {
    setMsg(undefined);
    try { const r = await api(path, { body }); setMsg({ kind: 'success', text: ok(r) }); load(); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  async function setting(patch: Record<string, unknown>, text: string) {
    try { await api('/admin/tenant', { method: 'PATCH', body: { settings: patch } }); await refresh(); await load(); setMsg({ kind: 'success', text }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  const counts = (c: Record<string, number>) => ['SENT', 'QUEUED', 'FAILED', 'TEST'].filter((k) => c[k]).map((k) => `${c[k]} ${k.toLowerCase()}`).join(' · ') || 'nothing yet';

  return (
    <div className="page">
      <header className="page-head"><div><h1>Integrations</h1><p className="muted">Email, SMS, file storage, verification and AI. Providers are set up on the server; everything runs safely in <strong>test mode</strong> until keys are added.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!s.jobs.running && !s.devMode && <Alert kind="warning">The background job queue isn’t running — emails and document reading are processed in-line. Check server logs.</Alert>}
      <div className="int-grid">
        <Card title="Email" live={s.email.live} provider={s.email.provider} env={'EMAIL_PROVIDER=smtp            # or sendgrid\nEMAIL_FROM="Acme Supplier Portal <no-reply@yourdomain.com>"\nSMTP_HOST=email-smtp.ap-south-1.amazonaws.com   # SES, M365, Gmail…\nSMTP_USER=...\nSMTP_PASS=...\n# or: SENDGRID_API_KEY=SG....'}>
          <p className="small muted">From: {s.email.from}<br />This workspace: {counts(s.email.counts)}</p>
          {s.email.lastFailures.length > 0 && <ul className="plain-list small">{s.email.lastFailures.map((f, i) => <li key={i}><span className="diff-text">Failed</span> {f.subject} → {f.to}<span className="muted block">{f.error} · {fmtDateTime(f.createdAt)}</span></li>)}</ul>}
          <button className="btn btn-secondary btn-sm" onClick={() => run('/admin/integrations/test-email', {}, (r) => s.email.live ? `Test email sent to ${r.to}.` : `Test email recorded for ${r.to} — see Mailbox (test mode).`)}>Send me a test email</button>
        </Card>

        <Card title="SMS" live={s.sms.live} provider={s.sms.provider} env={'SMS_PROVIDER=msg91            # India (DLT)\nMSG91_AUTH_KEY=...\nMSG91_OTP_TEMPLATE_ID=...      # DLT-approved OTP template\n# or for international numbers:\n# SMS_PROVIDER=twilio\n# TWILIO_ACCOUNT_SID=AC...  TWILIO_AUTH_TOKEN=...  TWILIO_FROM=+1...'}>
          <p className="small muted">This workspace: {counts(s.sms.counts)}</p>
          <div className="field"><label htmlFor="otp-ch">Send vendor sign-in codes by</label>
            <select id="otp-ch" value={otp} onChange={(e) => setting({ vendorOtpChannel: e.target.value }, 'Sign-in code delivery updated.')}>
              <option value="email">Email only</option><option value="sms">SMS (email if SMS fails)</option><option value="both">Email and SMS</option>
            </select></div>
          <div className="inline-form">
            <input placeholder="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Mobile number for test" />
            <button className="btn btn-secondary btn-sm" disabled={phone.length < 8} onClick={() => run('/admin/integrations/test-sms', { to: phone }, () => (s.sms.live ? 'Test SMS sent.' : 'Test SMS recorded (test mode — nothing was sent).'))}>Send test SMS</button>
          </div>
        </Card>

        <Card title="Document storage" live={s.storage.driver !== 'local'} provider={s.storage.driver} env={'STORAGE_DRIVER=s3              # AWS S3, Cloudflare R2, MinIO…\nS3_BUCKET=vendor-docs\nS3_REGION=ap-south-1\nS3_ACCESS_KEY_ID=...\nS3_SECRET_ACCESS_KEY=...\n# S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com\n# or: STORAGE_DRIVER=azure + AZURE_STORAGE_CONNECTION_STRING=...\n\nSCAN_PROVIDER=clamav           # virus scanning via clamd\nCLAMAV_HOST=127.0.0.1'}>
          <p className="small muted">{s.storage.bucket ? `Bucket / container: ${s.storage.bucket}` : 'Files are stored on the server’s disk (fine for a single server; use cloud storage in production).'}<br />
            Virus scanning: {s.storage.scan === 'clamav' ? 'ClamAV' : 'off'} · File contents are always checked to be real PDF / PNG / JPG, and PDFs with scripts are refused.</p>
          <button className="btn btn-secondary btn-sm" onClick={() => run('/admin/integrations/test-storage', {}, (r) => `Storage OK — ${r.detail}.`)}>Check storage</button>
        </Card>

        <Card title="GSTIN / PAN / bank / MCA checks" live={s.kyc.live} provider={s.kyc.provider} env={'KYC_PROVIDER=surepass\nSUREPASS_TOKEN=...\nSUREPASS_BASE_URL=https://kyc-api.surepass.io/api/v1   # sandbox: https://sandbox.surepass.io/api/v1\n# endpoint paths can be overridden: SUREPASS_PATH_GSTIN, _PAN, _BANK, _CIN'}>
          <p className="small muted">Vendors run checks from the form; reviewers can re-run them from the vendor page. Identical checks are reused for 24 hours and limited per vendor per day to control provider fees. Only masked identifiers are stored.</p>
          {!s.kyc.live && <p className="small">Test mode answers instantly. Numbers whose 9th (PAN) or 13th (GSTIN) character is <code>0</code>, or bank accounts ending in <code>0</code>, come back “not found”.</p>}
        </Card>

        <Card title="AI document reading" live={s.ai.live} provider={s.ai.provider} env={'AI_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-...\nAI_MODEL=claude-sonnet-5-5      # or claude-haiku-4-5-20251001 for lower cost'}>
          <p className="small muted">Reads GST, PAN, cheque, incorporation and Udyam documents, suggests values for the form, and shows reviewers where documents and form answers differ.{s.ai.model && <> Model: <code>{s.ai.model}</code>.</>}</p>
          <label className="check-item"><input type="checkbox" checked={s.ai.enabledForWorkspace} onChange={(e) => { const on = e.target.checked; setS({ ...s, ai: { ...s.ai, enabledForWorkspace: on } }); setting({ aiExtraction: on }, on ? 'AI document reading turned on.' : 'AI document reading turned off.'); }} />
            <span><strong>Use AI to read uploaded documents in this workspace</strong><span className="muted small block">Documents are sent to the AI provider for reading and are not used to train models. Check this fits your data-protection obligations before turning it on.{!s.ai.live && ' (In test mode no document leaves the server.)'}</span></span></label>
        </Card>
      </div>
    </div>
  );
}
