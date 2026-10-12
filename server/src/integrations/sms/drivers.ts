/**
 * SMS drivers. India requires DLT registration: MSG91 sends via an approved Flow template
 * (pass variables, not free text). Twilio covers international numbers.
 */
export interface OutgoingSms { to: string; body: string; vars?: Record<string, string>; purpose: string }
export interface SmsDriver { name: string; live: boolean; send(m: OutgoingSms): Promise<{ id?: string }> }

export const testSmsDriver: SmsDriver = { name: 'test', live: false, async send() { return {}; } };

/** E.164 without '+': 9876543210 → 919876543210 */
export function normaliseMobile(raw: string, defaultCc = '91') {
  const d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.length === 10) return `${defaultCc}${d}`;
  if (d.length === 11 && d.startsWith('0')) return `${defaultCc}${d.slice(1)}`;
  return d;
}

export function msg91Driver(cfg: { authKey: string; templates: Record<string, string> }, fetchImpl: typeof fetch = fetch): SmsDriver {
  return {
    name: 'msg91', live: true,
    async send(m) {
      const template_id = cfg.templates[m.purpose];
      if (!template_id) throw new Error(`No MSG91 template configured for "${m.purpose}"`);
      const res = await fetchImpl('https://control.msg91.com/api/v5/flow', {
        method: 'POST',
        headers: { authkey: cfg.authKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ template_id, short_url: '0', recipients: [{ mobiles: m.to, ...(m.vars ?? {}) }] }),
      });
      const json = await res.json().catch(() => ({})) as { type?: string; message?: string };
      if (!res.ok || json.type === 'error') throw new Error(`MSG91 ${res.status}: ${json.message ?? 'send failed'}`);
      return { id: json.message };
    },
  };
}

export function twilioDriver(cfg: { sid: string; token: string; from: string }, fetchImpl: typeof fetch = fetch): SmsDriver {
  return {
    name: 'twilio', live: true,
    async send(m) {
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: `+${m.to}`, From: cfg.from, Body: m.body }),
      });
      const json = await res.json().catch(() => ({})) as { sid?: string; message?: string };
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message ?? 'send failed'}`);
      return { id: json.sid };
    },
  };
}
