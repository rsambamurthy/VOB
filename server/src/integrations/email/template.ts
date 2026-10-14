/** Branded, mobile-friendly HTML email (table layout for Outlook), plus a plain-text alternative. */
import type { TenantBranding } from '../../db/schema.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderEmail(opts: { subject: string; body: string; link?: string | null; tenantName?: string; branding?: TenantBranding }) {
  const color = /^#[0-9a-f]{6}$/i.test(opts.branding?.primaryColor ?? '') ? opts.branding!.primaryColor! : '#1f2758';
  const product = opts.branding?.productName ?? 'VendorGate';
  const sender = opts.tenantName ? `${opts.tenantName} · ${product}` : product;
  const paragraphs = esc(opts.body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  // Supplier emails written in Arabic are laid out right-to-left with Arabic wording around them.
  const ar = /[\u0600-\u06ff]/.test(`${opts.subject} ${opts.body}`);
  const dir = ar ? ' dir="rtl"' : '';
  const align = ar ? 'right' : 'left';
  const linkText = ar ? (opts.link?.includes('/onboard/') ? 'فتح بوابة الموردين' : 'فتح') : opts.link?.includes('/onboard/') ? 'Open the supplier portal' : opts.link?.includes('/reset-password/') ? 'Reset password' : opts.link?.includes('/accept-invite/') ? 'Accept invitation' : 'Open';
  const t = ar
    ? { copy: 'إذا لم يعمل الزر، انسخوا هذا الرابط:', auto: `هذه رسالة آلية من ${esc(sender)}. لا تردّوا بكلمات مرور أو رموز.`, powered: 'مدعوم من' }
    : { copy: 'If the button doesn\'t work, copy this link:', auto: `This is an automated message from ${esc(sender)}. Please don't reply with passwords or codes.`, powered: 'Powered by' };
  const button = opts.link
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 18px"><tr><td style="border-radius:8px;background:${color}"><a href="${esc(opts.link)}" style="display:inline-block;padding:12px 22px;color:#fff;text-decoration:none;font-weight:600;font-family:Arial,sans-serif">${linkText}</a></td></tr></table>
       <p style="margin:0 0 14px;font-size:12px;color:#6f6a78">${t.copy}<br><a href="${esc(opts.link)}" style="color:${color};word-break:break-all">${esc(opts.link)}</a></p>`
    : '';
  const logo = opts.branding?.logoUrl ? `<img src="${esc(opts.branding.logoUrl)}" alt="" height="28" style="vertical-align:middle;margin-right:8px">` : '';
  const html = `<!doctype html><html${ar ? ' lang="ar" dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(opts.subject)}</title></head>
<body${dir} style="margin:0;background:#f6f5f8;font-family:${ar ? 'Tahoma,Arial,sans-serif' : 'Arial,Helvetica,sans-serif'};color:#1d1a22">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e6e2ea">
<tr><td style="background:${color};padding:14px 22px;color:#fff;font-weight:700;font-size:15px">${logo}${esc(sender)}</td></tr>
<tr><td${dir} style="padding:22px;font-size:14px;line-height:1.7;text-align:${align}">${paragraphs}${button}</td></tr>
<tr><td${dir} style="padding:12px 22px;background:#fcfbfd;border-top:1px solid #e6e2ea;font-size:11.5px;color:#6f6a78;text-align:${align}">${t.auto}<br><span style="color:#8a8595">${t.powered} <strong style="font-family:Georgia,serif;color:#1f2758">VendorGate</strong> · <a href="https://integratatech.ai" style="color:#8a8595">Integratatech.ai Pvt Ltd</a></span></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${opts.body}${opts.link ? `\n\n${linkText}: ${opts.link}` : ''}\n\n— ${sender}\n${t.powered} VendorGate · Integratatech.ai Pvt Ltd`;
  return { html, text };
}
