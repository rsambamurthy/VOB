import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Alert, Empty, Modal } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { HelpBody } from '../../help/HelpPanel';

interface Topic { id: string; topicId: string; title: string; summary: string; body: string; audience: 'staff' | 'supplier' | 'both'; keywords: string; updatedAt: string; updatedBy: string | null }
const AUD: Record<Topic['audience'], string> = { staff: 'Your staff', supplier: 'Suppliers', both: 'Staff and suppliers' };
const blank = { title: '', summary: '', body: '', audience: 'staff' as Topic['audience'], keywords: '' };

/** Administration → Help topics: the workspace's own pages in F1 help (approval policy, contacts, cut-off dates…). */
export function HelpTopics() {
  const [rows, setRows] = useState<Topic[]>();
  const [edit, setEdit] = useState<(typeof blank & { topicId?: string }) | null>(null);
  const [preview, setPreview] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = () => api<Topic[]>('/help/topics/all').then(setRows).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  async function save() {
    if (!edit) return;
    try {
      const body = { title: edit.title, summary: edit.summary, body: edit.body, audience: edit.audience, keywords: edit.keywords || undefined };
      await api(edit.topicId ? `/help/topics/${edit.topicId}` : '/help/topics', { method: edit.topicId ? 'PUT' : 'POST', body });
      setEdit(null); setMsg({ kind: 'success', text: 'Saved. It shows in F1 help straight away.' }); load();
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  async function remove(t: Topic) {
    try { await api(`/help/topics/${t.topicId}`, { method: 'DELETE' }); setMsg({ kind: 'success', text: `“${t.title}” deleted.` }); load(); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  return (
    <div className="page narrow-page">
      <header className="page-head"><div><h1>Help topics</h1><p className="muted">Your own pages in F1 help, next to VendorGate’s — for example your approval policy, payment terms or who to call. AI answers use them too.</p></div>
        <button className="btn btn-primary" onClick={() => { setEdit({ ...blank }); setPreview(false); }}>Add topic</button></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="card">
        {!rows ? <div className="pad"><div className="spinner" /></div> : !rows.length ? <Empty>No topics yet. Add one for anything your staff or suppliers keep asking about.</Empty> : (
          <table className="table static">
            <thead><tr><th>Topic</th><th>Shown to</th><th>Updated</th><th /></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.id}><td><div className="strong">{t.title}</div><div className="muted small">{t.summary}</div></td><td className="small">{AUD[t.audience]}</td>
                <td className="small muted">{fmtDate(t.updatedAt)}{t.updatedBy && <div>{t.updatedBy}</div>}</td>
                <td className="actions"><button className="link-btn small" onClick={() => { setEdit({ topicId: t.topicId, title: t.title, summary: t.summary, body: t.body, audience: t.audience, keywords: t.keywords }); setPreview(false); }}>Edit</button> · <button className="link-btn small danger" onClick={() => remove(t)}>Delete</button></td></tr>))}</tbody>
          </table>
        )}
      </div>
      {edit && (
        <Modal title={edit.topicId ? 'Edit help topic' : 'New help topic'} wide onClose={() => setEdit(null)}
          footer={<><button className="btn btn-ghost" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={edit.title.trim().length < 3 || edit.body.trim().length < 10} onClick={save}>Save</button></>}>
          {preview ? <article className="help-article"><h2>{edit.title}</h2><HelpBody text={edit.body} go={() => {}} known={new Set()} /></article> : (
            <>
              <div className="field-grid">
                <div className="field"><label htmlFor="ht-title">Title</label><input id="ht-title" value={edit.title} maxLength={120} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="e.g. Our approval policy" /></div>
                <div className="field"><label htmlFor="ht-aud">Shown to</label><select id="ht-aud" value={edit.audience} onChange={(e) => setEdit({ ...edit, audience: e.target.value as Topic['audience'] })}>{Object.entries(AUD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              </div>
              <div className="field"><label htmlFor="ht-sum">One-line summary</label><input id="ht-sum" value={edit.summary} maxLength={240} onChange={(e) => setEdit({ ...edit, summary: e.target.value })} /></div>
              <div className="field"><label htmlFor="ht-body">Text</label><textarea id="ht-body" rows={12} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
                <div className="field-help">Blank line = new paragraph. **bold**, “- ” for a list, “1. ” for steps, “## ” for a heading.</div></div>
              <div className="field"><label htmlFor="ht-kw">Search words (optional)</label><input id="ht-kw" value={edit.keywords} maxLength={300} onChange={(e) => setEdit({ ...edit, keywords: e.target.value })} placeholder="other words people might type" /></div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
