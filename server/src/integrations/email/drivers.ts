import nodemailer, { type Transporter } from 'nodemailer';

export interface OutgoingEmail { to: string; from: string; replyTo?: string; subject: string; html: string; text: string }
export interface EmailDriver { name: string; live: boolean; send(m: OutgoingEmail): Promise<{ id?: string }> }

/** Test mode: nothing leaves the server; the message is visible in the dev Mailbox. */
export const testDriver: EmailDriver = { name: 'test', live: false, async send() { return { id: undefined }; } };

/** Any SMTP service: Amazon SES (SMTP credentials), SendGrid SMTP, Microsoft 365, Google Workspace, Zoho, Mailgun… */
export function smtpDriver(cfg: { host: string; port: number; secure: boolean; user?: string; pass?: string }): EmailDriver {
  let t: Transporter | null = null;
  const transport = () => (t ??= nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined, pool: true, maxConnections: 3 }));
  return {
    name: 'smtp', live: true,
    async send(m) {
      const info = await transport().sendMail({ from: m.from, to: m.to, replyTo: m.replyTo, subject: m.subject, html: m.html, text: m.text });
      return { id: info.messageId };
    },
  };
}

/** SendGrid Web API v3 (no SDK). */
export function sendgridDriver(cfg: { apiKey: string }, fetchImpl: typeof fetch = fetch): EmailDriver {
  const parse = (addr: string) => { const m = addr.match(/^\s*(.*?)\s*<(.+)>\s*$/); return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2] } : { email: addr.trim() }; };
  return {
    name: 'sendgrid', live: true,
    async send(m) {
      const res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: m.to }] }],
          from: parse(m.from), ...(m.replyTo ? { reply_to: parse(m.replyTo) } : {}),
          subject: m.subject,
          content: [{ type: 'text/plain', value: m.text }, { type: 'text/html', value: m.html }],
          tracking_settings: { click_tracking: { enable: false } }, // keep one-time links intact
        }),
      });
      if (!res.ok) throw new Error(`SendGrid ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { id: res.headers.get('x-message-id') ?? undefined };
    },
  };
}
