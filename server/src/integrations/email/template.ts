/** Branded, mobile-friendly HTML email (table layout for Outlook), plus a plain-text alternative. */
import type { TenantBranding } from '../../db/schema.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderEmail(opts: { subject: string; body: string; link?: string | null; tenantName?: string; branding?: TenantBranding }) {
  const color = /^#[0-9a-f]{6}$/i.test(opts.branding?.primaryColor ?? '') ? opts.branding!.primaryColor! : '#6d1a73';
  const product = opts.branding?.productName ?? 'VendorGate';
  const sender = opts.tenantName ? `${opts.tenantName} · ${product}` : product;
  const paragraphs = esc(opts.body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  const linkText = opts.link?.includes('/onboard/') ? 'Open the supplier portal' : opts.link?.includes('/reset-password/') ? 'Reset password' : opts.link?.includes('/accept-invite/') ? 'Accept invitation' : 'Open';
  const button = opts.link
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 18px"><tr><td style="border-radius:8px;background:${color}"><a href="${esc(opts.link)}" style="display:inline-block;padding:12px 22px;color:#fff;text-decoration:none;font-weight:600;font-family:Arial,sans-serif">${linkText}</a></td></tr></table>
       <p style="margin:0 0 14px;font-size:12px;color:#6f6a78">If the button doesn't work, copy this link:<br><a href="${esc(opts.link)}" style="color:${color};word-break:break-all">${esc(opts.link)}</a></p>`
    : '';
  const logo = opts.branding?.logoUrl ? `<img src="${esc(opts.branding.logoUrl)}" alt="" height="28" style="vertical-align:middle;margin-right:8px">` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(opts.subject)}</title></head>
<body style="margin:0;background:#f6f5f8;font-family:Arial,Helvetica,sans-serif;color:#1d1a22">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e6e2ea">
<tr><td style="background:${color};padding:14px 22px;color:#fff;font-weight:700;font-size:15px">${logo}${esc(sender)}</td></tr>
<tr><td style="padding:22px;font-size:14px;line-height:1.55">${paragraphs}${button}</td></tr>
<tr><td style="padding:12px 22px;background:#fcfbfd;border-top:1px solid #e6e2ea;font-size:11.5px;color:#6f6a78">This is an automated message from ${esc(sender)}. Please don't reply with passwords or codes.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${opts.body}${opts.link ? `\n\n${linkText}: ${opts.link}` : ''}\n\n— ${sender}`;
  return { html, text };
}
