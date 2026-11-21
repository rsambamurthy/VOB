/**
 * In-app help (F1). Each article says who sees it, which screens it belongs to, and its text.
 *
 * Body syntax (kept deliberately small, see HelpPanel's renderer):
 *   ## Heading · blank line = new paragraph · "- " bullets · "1. " steps · **bold** · `code`
 *   [text](#article-id) link to another article · ![alt](/help/file.jpg) screenshot
 *   @video(/help/file.mp4 | caption) looping animation · > note line (shown as a tip)
 */
import type { Permission } from '../lib/types';

export type Audience = 'staff' | 'supplier' | 'platform' | 'public';
export interface HelpArticle {
  id: string;
  title: string;
  /** One line shown in search results. */
  summary: string;
  audience: Audience[];
  /** Staff only: shown when the user has ANY of these permissions. */
  perms?: Permission[];
  /** Hidden when the workspace's plan doesn't include the feature. */
  feature?: 'erp' | 'ai' | 'kyc' | 'collab' | 'sourcing' | 'contracts' | 'invoices';
  /** Regexes on the URL path; the first matching article is the screen's main topic. */
  screens?: string[];
  /** In-page contexts (set by a screen with useHelpContext), e.g. a configuration tab. */
  contexts?: string[];
  /** Extra words people might search for. */
  keywords?: string;
  related?: string[];
  body: string;
}

export const ARTICLES: HelpArticle[] = [
  /* ---------------- Getting started ---------------- */
  {
    id: 'sign-in', title: 'Signing in', audience: ['public', 'staff'],
    summary: 'Workspace ID, email and password; forgot password; locked accounts.',
    screens: ['^/login', '^/forgot-password', '^/reset-password', '^/accept-invite'],
    keywords: 'login log in password forgot reset locked workspace id invitation invite link cannot access',
    related: ['account-2fa', 'password-sessions', 'troubleshooting'],
    body: `Staff sign in with three things: the **Workspace ID** (for example \`acme\`), their email and their password. The workspace ID is in your invitation email; ask your administrator if you don't have it.

![The staff sign-in page](/help/01-login.jpg)

## First time
Open the link in your invitation email and choose a password: at least 10 characters, using three of lowercase, uppercase, numbers and symbols. The link is valid for 7 days; if it has expired, ask your administrator to use **Resend invite**.

## Forgot your password
Click **Forgot password?** on the sign-in page. The reset link is valid for 1 hour. Resetting signs you out everywhere else.

## Locked out
After 5 wrong passwords the account is locked for 15 minutes. An administrator can **Unlock** it sooner under Users.

> Suppliers never use this page. They sign in with the link in their invitation email and a one-time code.`,
  },
  {
    id: 'getting-started', title: 'Setting up a new workspace', audience: ['staff'], perms: ['users.manage', 'tenant.settings', 'config.manage'],
    summary: 'The first steps for administrators: branding, security, team, configuration.',
    keywords: 'setup set up new start onboarding first steps checklist administrator admin welcome',
    related: ['workspace-settings', 'users', 'roles', 'config-overview'],
    body: `A new workspace is ready to use in about 15 minutes.

1. **Brand it** under Administration → Workspace: company name, portal name, colour and logo. See [Workspace settings](#workspace-settings).
2. **Secure it** on the same page: require two-factor authentication for all staff.
3. **Invite your team** under Users, giving each person at least one role. See [Users](#users) and [Roles](#roles).
4. **Check the supplier form and approval flow** under Configuration, then publish. See [Configuring onboarding](#config-overview).
5. **Send a test email** from Integrations, to be sure invitations reach inboxes. See [Email, SMS and other integrations](#integrations).
6. **Invite your first vendor.** See [Inviting a vendor](#invite-vendor).`,
  },
  {
    id: 'billing', title: 'Plan, billing and invoices', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'Upgrade from the trial, keep your billing details current, and download and pay tax invoices.',
    screens: ['^/staff/admin/billing'],
    keywords: 'billing invoice plan upgrade trial pay payment razorpay gst gstin tax invoice pdf renewal subscription price',
    related: ['workspace-settings'],
    body: `Administration → **Billing** shows your plan, billing details and invoices.

- **Billing details**: the legal name, address, billing email and — in India — the state and GSTIN printed on your tax invoices. With a GSTIN, the state is taken from it.
- **Upgrade**: on the free trial, choose monthly or yearly and click **Upgrade to Standard**. An invoice is created at once; the Standard plan starts as soon as it is paid. Nothing you set up in the trial is lost.
- **Invoices**: download each as a PDF. **Pay now** opens a secure payment page (cards, UPI, net banking). You can also pay by bank transfer to the account on the invoice.
- **Tax**: Indian customers are charged GST — CGST and SGST in the seller's state, IGST elsewhere. Customers outside India are invoiced in US dollars as an export of services, without GST.
- **Renewals**: the next invoice is issued automatically at the end of each period and emailed to the billing email. Reminders follow if it isn't paid by the due date.`,
  },
  {
    id: 'help-topics', title: 'Your own help topics and AI answers', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'Add pages about your own policies to F1 help, and let people ask questions in their own words.',
    screens: ['^/staff/admin/help-topics'],
    keywords: 'help topic policy faq ask question ai answer assistant own page suppliers',
    related: ['integrations'],
    body: `Administration → **Help topics** lets you add your own pages to F1 help — for example your approval policy, payment terms, cut-off dates or who to call. Choose whether each is shown to **your staff**, to **suppliers** in their portal, or to both. They appear in search straight away.

**Ask a question**: type a question in the F1 search box (for example “who approves a bank change?”) and click **Ask**. The answer is written only from the help topics that person can see — VendorGate's and yours — with links to the topics it used. Turn this on or off under Administration → **Integrations** → AI.`,
  },
  {
    id: 'email-delivery', title: 'Email delivery', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'Sender name, reply-to, your own sending domain, and what happens when an email bounces.',
    keywords: 'email sender from name reply to domain dns spf dkim bounce bounced spam complaint suppressed contact change',
    related: ['workspace-settings', 'integrations'],
    body: `Administration → **Workspace** → **Email**:

- **Sender name** and **Replies go to**: what suppliers see in their inbox and where their replies land.
- **Your own sending domain** (paid plans): enter a domain such as mail.yourcompany.com, add the DNS records shown at your DNS provider, then **Check again**. Once verified, email goes out from that domain.
- **Addresses that bounced**: when a supplier's contact address doesn't exist or reports our email as spam, VendorGate stops sending to it and flags the supplier **Contact email bouncing**. Fix it with **change** next to the contact on the supplier's page (the old address gets a security notice), or click **Send to it again** if the mailbox is working again.`,
  },
  {
    id: 'workspace-settings', title: 'Workspace settings', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'Company name, branding, staff 2FA, session length and the vendor re-check cycle.',
    screens: ['^/staff/admin/workspace'],
    keywords: 'branding logo colour color company name portal name security two factor session hours lifecycle recheck re-check months',
    related: ['getting-started', 'account-2fa', 'privacy', 'block-recheck'],
    body: `Administration → **Workspace** holds the settings for the whole company.

![Workspace settings](/help/02-workspace.jpg)

- **Company & branding**: the name, portal name, brand colour and logo link that suppliers see in their portal and in emails.
- **Security**: tick **Require two-factor authentication for all staff** to make 2FA compulsory. Set how many hours a sign-in lasts (1–72, default 12).
- **Vendor lifecycle**: how often approved vendors are re-checked (default 12 months; 0 turns it off). See [Block and re-check](#block-recheck).
- **Email**: the sender name suppliers see, where replies go, sending from your own domain (paid plans), and addresses that bounced. See [Email delivery](#email-delivery).
- **Privacy & data retention**: the privacy notice suppliers accept and how long old registrations are kept. See [Privacy and data protection](#privacy).
- **Supplier portal language** (Gulf workspaces): English or Arabic for new suppliers. See [Arabic for suppliers](#supplier-language).

Changes apply as soon as you click **Save**.`,
  },
  {
    id: 'ask', title: 'Ask about your suppliers (AI search)', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Type a question in plain words and get the matching suppliers, documents, approvals, orders or invoices.',
    screens: ['^/staff/ask'], contexts: ['ask'],
    keywords: 'ask ai search question natural language find query which who list show expiring stuck bank changes invoices orders',
    related: ['reports', 'vendor-list'],
    body: `Use the **Ask about your suppliers…** box in the top bar, or **Ask** in the menu. Type a question the way you'd ask a colleague, for example:

- "Which approved suppliers in Riyadh have a CR expiring this quarter?"
- "Show suppliers waiting in Finance review for more than 5 days"
- "Who changed their bank details in the last 30 days?"
- "Open purchase orders over 1m with no shipment notice yet"
- "Invoices in exception this month, by supplier"

The answer is a list of records with a heading that says exactly what was searched. Click a row to open it, or **Download Excel** for the same list.

## How it works
- The AI reads only your question and turns it into one of VendorGate's built-in searches. It never sees supplier data, and it can't change anything.
- You see only what your role allows: purchasing questions need access to purchase orders.
- Bank account numbers, IBANs and tax IDs are never shown in answers.
- Every question is recorded in the audit log.

> If the heading isn't what you meant, rephrase the question. For fixed lists with filters, use [Reports](#reports). An administrator can turn Ask off under Administration → Integrations.`,
  },
  {
    id: 'supplier-language', title: 'Arabic for suppliers', audience: ['staff'], perms: ['tenant.settings', 'config.manage', 'vendors.create'],
    summary: 'Gulf workspaces: suppliers can use the portal, emails and SMS in Arabic.',
    screens: ['^/staff/admin/workspace', '^/staff/admin/config'],
    keywords: 'arabic language العربية rtl right to left translate translation hijri gulf saudi supplier language',
    related: ['workspace-settings', 'invite-vendor', 'config-overview'],
    body: `In a Gulf workspace each supplier can use the portal in **English or Arabic**. Your own screens stay in English.

## What the supplier sees in Arabic
- The portal reads right to left, with the form, documents, guide, help topics, privacy notice and error messages in Arabic.
- Dates show the Hijri (Umm al-Qura) date beside the Gregorian one.
- Emails and SMS (sign-in codes, approval, corrections, reminders, orders, invoices) are sent in the supplier's language.

## Choosing the language
1. Administration → **Workspace** → **Supplier portal language** sets the language for new suppliers.
2. When you invite a vendor, **Supplier's language** sets it for that supplier.
3. Suppliers can switch at any time with the button in the portal header; their choice is kept.

![Choosing the supplier's language when inviting](/help/24-invite-language.jpg)

![An order in the Arabic supplier portal](/help/21-arabic-portal.jpg)

## Your own fields
Built-in Gulf wording already has Arabic. For fields, sections, documents and guide items you add, fill in the **Arabic** boxes in Configuration. Leave a box blank to use the built-in Arabic (or English when there is none).

> Answers are stored in English whatever language the supplier used, so reviews, reports and the ERP export don't change.`,
  },
  {
    id: 'users', title: 'Users: invite, change roles, disable', audience: ['staff'], perms: ['users.manage'],
    summary: 'Invite staff, change their roles, disable, unlock or reset 2FA.',
    screens: ['^/staff/admin/users'],
    keywords: 'user users staff team invite add person remove disable deactivate unlock reset 2fa mfa resend invitation colleague',
    related: ['roles', 'account-2fa', 'plan-limits'],
    body: `Administration → **Users** lists everyone in the workspace with their roles, status, 2FA and last sign-in.

![The Users page](/help/03-users.jpg)

## Invite someone
1. Click **Invite user**.
2. Enter their name and email and pick at least one role.
3. They receive an email link valid for 7 days. Use **Resend invite** if it expires.

## Other actions
- **Edit**: change name or roles.
- **Disable**: signs them out at once and blocks sign-in. **Enable** brings them back.
- **Unlock**: clears a lock after 5 wrong passwords.
- **Reset 2FA**: for someone who lost their phone and recovery codes; they set it up again at the next sign-in.

> You can't disable the last active Administrator. The number of users may be limited by your plan; see [Plan limits and trial](#plan-limits).`,
  },
  {
    id: 'roles', title: 'Roles and permissions', audience: ['staff'], perms: ['users.manage'],
    summary: 'What each default role can do, and how to create your own.',
    screens: ['^/staff/admin/roles'],
    keywords: 'role roles permission permissions access rights administrator vendor admin tax finance master data mdm viewer who can contract manager legal counsel contract viewer contract approver contracts plan',
    related: ['users', 'config-workflow'],
    body: `A role is a bundle of permissions. Every workspace starts with these roles; edit them or click **New role** to make your own.

![The Roles page](/help/04-roles.jpg)

- **Administrator**: everything.
- **Vendor Admin**: view and invite vendors, see reports.
- **Tax Accounts Manager**: view vendors; handles the tax review level.
- **Finance Manager**: view vendors and reports; handles the finance and risk level.
- **Master Data Manager**: final approval, ERP export, block vendors, propose changes.
- **Viewer**: read-only.
- **Buyer**: purchase orders and supplier collaboration.
- With Contracts: **Contract Manager** (contracts, parties, templates), **Legal Counsel** (templates, clause library and legal review), **Contract Viewer** (read-only contracts) and **Contract Approver** (choose it in the contract approval levels).

On the **Contracts plan** (no supplier onboarding) only the Administrator and the contract roles are shown, and permissions for onboarding, orders and sourcing can't be ticked — they would do nothing. If the plan later adds onboarding, its roles appear by themselves.

> Who approves what is set by the approval flow, not by permissions. A person can act on an approval step when they hold the role that step is assigned to. See [Approval flow](#config-workflow).`,
  },

  /* ---------------- Configuration ---------------- */
  {
    id: 'config-overview', title: 'Configuring onboarding: drafts and publishing', audience: ['staff'], perms: ['config.manage'],
    summary: 'Edit the supplier form safely in a draft, preview it, then publish.',
    screens: ['^/staff/admin/config'], contexts: ['config-form'],
    keywords: 'configuration config form fields field section tab draft publish preview required validation rule show hide condition',
    related: ['config-documents', 'config-workflow', 'config-guide-history'],
    body: `Administration → **Configuration** controls what suppliers fill in and who approves them. Every change is made in a **draft** and reaches suppliers only when you publish.

![The Form fields tab](/help/05-config-form.jpg)

## Form fields
The tabs suppliers see are listed on the left; their fields on the right. For each field you can set the label, whether it's required, a format check (GSTIN, PAN, IFSC and so on) and a rule to show it only in some cases, for example only for foreign suppliers. Use **+ Add tab** for a new section.

In a Gulf workspace each field, tab, document and guide item also has **Arabic** boxes for suppliers who use the portal in Arabic. Built-in fields already have Arabic; fill in the boxes for the ones you add. See [Arabic for suppliers](#supplier-language).

## Publish
1. Edit anything; the bar at the top shows you have an unpublished draft.
2. Click **Preview form** to see it as a supplier will.
3. Click **Publish…**, add an optional note, and confirm.

Suppliers part-way through see the new version next time they open their portal; the answers they saved are kept. Click **Discard draft** to throw your changes away.

## Editing the form in Excel
1. Click **Download as Excel**. You get the current form: a **Tabs**, **Fields** and **Documents** sheet, and **How to fill in** with the rules and examples.
2. Add rows for new tabs, fields or documents, change any column of existing rows, or write **Remove** in the Action column. Leaving a row out never deletes anything; the row order sets the order on screen.
3. Conditions are written like \`basic.supplierCountry = India\`, \`tax.hasGst = Yes\`, \`basic.entityType in Company (Pvt / Public Ltd); Limited Liability Partnership\` or \`risk.annualTurnover > 50000000\`.
4. Click **Upload Excel…** and choose the file. You see every change (and any mistakes, by sheet and row) before anything is saved.
5. **Save to the draft**, check it in the editor, then **Publish**.

Keys of existing fields can't change (suppliers' answers are stored under them) — change the Label instead. Built-in fields can be relabelled, moved and made optional, but not removed.`,
  },
  {
    id: 'config-documents', title: 'Required documents', audience: ['staff'], perms: ['config.manage'],
    summary: 'Which documents suppliers upload, when they are required, and expiry tracking.',
    contexts: ['config-documents'],
    keywords: 'documents document upload certificate pan card gst certificate cancelled cheque expiry expire required optional',
    related: ['config-overview', 'document-expiry'],
    body: `The **Documents** tab of Configuration lists what suppliers must or may upload.

- **Required / Optional**: required documents block submission until uploaded. A rule can make one required only for some vendors.
- **Help text**: shown to the supplier beside the upload box.
- **Track expiry date**: the supplier enters the expiry date when uploading, and VendorGate sends reminders before it runs out. See [Document expiry](#document-expiry).

Suppliers can upload PDF, PNG or JPG files up to 5 MB. Publish the draft for changes to take effect.`,
  },
  {
    id: 'config-workflow', title: 'Approval flow', audience: ['staff'], perms: ['config.manage', 'approvals.manage'],
    summary: 'Review levels, who handles each, deadlines, and who reviews changes after approval.',
    contexts: ['config-workflow'],
    keywords: 'approval flow workflow level levels approver approvers sla deadline hours order sequence reviewer rule change rules after approval test the flow',
    related: ['review-decide', 'roles', 'change-requests'],
    body: `The **Approval flow** tab sets the review levels every registration goes through, top to bottom.

![The Approval flow tab](/help/06-config-workflow.jpg)

- **Level name** and **Handled by role**: everyone holding that role can act at that level.
- **Deadline (hours)**: after this the step is overdue and the people who handle it get an escalation email.
- **Every vendor / Only vendors where…**: limit a level to some vendors, for example only Import vendors.
- **Test the flow**: pick a vendor type to see which levels it would go through.

## Changes after approval
Choose which levels review a change to an approved vendor. By default bank details go to Finance and Master Data, tax details to Tax and Master Data, and anything else to Master Data. See [Change requests](#change-requests).`,
  },
  {
    id: 'config-guide-history', title: 'Portal guide and version history', audience: ['staff'], perms: ['config.manage'],
    summary: 'The steps suppliers read in their portal, and restoring an older configuration.',
    contexts: ['config-guide', 'config-history'],
    keywords: 'portal guide supplier instructions help text history version versions restore rollback undo previous',
    related: ['config-overview'],
    body: `## Portal guide
The steps suppliers see under **How onboarding works** in their portal. Write them in your own words, for example who to contact with questions.

## History
Every published version is kept with who published it and their note. Click **Restore as draft** to copy an older version into the draft, review it, then publish.`,
  },
  {
    id: 'scorecards', title: 'Supplier scorecards', audience: ['staff'], perms: ['vendors.view'],
    summary: 'A score out of 100 for each supplier from deliveries, order handling, invoices and buyer ratings.',
    screens: ['^/staff/scorecards'],
    keywords: 'scorecard performance kpi otd on-time delivery fill rate acknowledgement invoice accuracy asn rating grade supplier evaluation vendor rating',
    related: ['orders-overview', 'supplier-invoices'],
    body: `Open **Vendors → Scorecards** to see every supplier ranked, or **Scorecard** on a vendor's page.

## The measures
- **On-time delivery**: deliveries (goods receipts) on or before the promised date, or the need-by date if none was promised.
- **Fill rate**: quantity received against quantity ordered, on goods lines that fell due in the period.
- **Order acknowledgement**: orders the supplier accepted in the portal. Orders accepted automatically, or never answered, don't count. The average time to accept is shown too.
- **Invoice accuracy**: invoices that matched the order and receipts first time.
- **Shipment notices**: deliveries that came with a shipment notice (only if your workspace uses them).
- **Buyer rating**: buyers' 1–5 ratings of quality, delivery, service and communication. Click **Rate this supplier**; comments are internal.

The **score** is the weighted average of the measures that have data in the period (30, 90, 180 or 365 days), with at least 3 data points. Grades: **A** 90+, **B** 80+, **C** 70+, **D** below 70. **Change** compares with the period before.

## Weights and sharing
Administrators click **Weights & sharing** to change how much each measure counts (0 leaves it out), add grace days for on-time delivery, and let approved suppliers see their own scorecard in their portal — never other suppliers, buyer names or rating comments.

**Download Excel** exports the ranked list.`,
  },
  {
    id: 'sso', title: 'Sign-in and single sign-on (Microsoft, Okta, Google, SAML)', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'Let staff sign in with their work account, and decide whether VendorGate passwords stay on.',
    screens: ['^/staff/admin/sign-in'],
    keywords: 'scim provisioning deprovisioning automatic users sso single sign-on login sign in azure ad entra microsoft okta google workspace saml adfs oidc openid password 2fa mfa identity provider',
    related: ['users', 'workspace-settings'],
    body: `Open **Administration → Sign-in & SSO**. Staff can sign in with a **VendorGate password and two-factor authentication** (the default), or with **single sign-on** through your company's identity provider. Suppliers are not affected.

## Setting up single sign-on
1. Pick your provider: **Microsoft Entra ID** (Azure AD), **Okta**, **Google Workspace**, **another OpenID Connect provider**, or **SAML 2.0** (AD FS, Ping, JumpCloud…).
2. Register VendorGate in your provider using the URLs shown on the page (copy buttons): the **Redirect URI** for OpenID Connect, or the **ACS URL**, **Entity ID** and **metadata URL** for SAML.
3. Copy back what the provider gives you: tenant ID / domain, **client ID** and **client secret** (OpenID Connect), or the **sign-in URL** and **signing certificate** (SAML). Save.
4. Click **Test sign-in**. You go to your provider and come back signed in; the page then shows the setup as working.

## Who can sign in
- **Allowed email domains**: only these addresses can come in through single sign-on.
- People must already be **Users** in VendorGate, unless you tick **Create a VendorGate user on first sign-in** and choose the role they get.
- Invited users with single sign-on don't set a password — the invitation shows the sign-in button.

## Password sign-in
- **Keep it for everyone**, **Administrators only** (recommended: a way in if your provider is down), or **Off**.
- **Off** can only be chosen after an administrator has signed in through single sign-on with the current settings, so nobody gets locked out. Changing the provider details resets this check.
- With single sign-on, two-factor authentication is handled by your provider; VendorGate doesn't ask again.

## Automatic user set-up and removal (SCIM)
Tick **Accept users from my identity provider**, click **Create token**, and enter the **SCIM base URL** and **token** in your provider (Entra: Enterprise app → Provisioning → Automatic; Okta: app → Provisioning → SCIM 2.0). Then:
- People IT assigns to VendorGate are created here, with the role you choose for new users. Name and email changes follow.
- **Groups give roles of the same name** — a "Finance Manager" group gives the Finance Manager role. Groups with no matching role are refused; create the role first under Roles.
- Removing or disabling someone in the provider **disables** them here and signs them out at once. Their approvals and audit history stay.
- **New token** replaces the old one immediately. Every change from the provider is in the audit log as "SCIM (identity provider)".

Every sign-in, refused sign-in and settings change is recorded in the audit log.`,
  },
  {
    id: 'integrations', title: 'Email, SMS and other integrations', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'Test email delivery, choose how suppliers get sign-in codes, and how suppliers enter their details (manual, assisted or automatic from documents).',
    screens: ['^/staff/admin/integrations'],
    keywords: 'integration integrations email mail smtp resend sendgrid sms otp code delivery storage ai document reading data entry manual assisted automatic auto fill extraction documents first test email junk spam',
    related: ['troubleshooting', 'supplier-signin'],
    body: `Administration → **Integrations** shows each connected service and lets you test it.

- **Email**: click **Send me a test email**. The card shows how many emails were sent or failed.
- **Send vendor sign-in codes by**: Email only, or Email and SMS, or SMS (email if SMS fails).
- **How suppliers enter their details** (AI document reading):
  - **Manual**: suppliers type everything; no document is sent to AI.
  - **Assisted**: after each upload, VendorGate suggests values and the supplier picks which to use.
  - **Automatic — documents first**: suppliers start with their documents and the form is filled in from them. Only values read with high confidence go into empty fields. Bank details and tax numbers always wait for the supplier to confirm, and nothing the supplier typed is overwritten. Each automatic fill is in the audit log, and reviewers see which document every value came from.
  Assisted and Automatic need AI on your plan.
- **Storage** and **verification**: shows where documents are stored and whether online checks are live.

> If emails land in Junk, ask recipients to mark them **Not junk** and add the sender to their contacts.`,
  },

  /* ---------------- Vendors ---------------- */
  {
    id: 'invite-vendor', title: 'Inviting a vendor', audience: ['staff'], perms: ['vendors.create'],
    summary: 'Create a vendor and email them a secure registration link.',
    screens: ['^/staff/vendors/?$'],
    keywords: 'new vendor add vendor create supplier invite invitation register onboard resend link email contact language arabic',
    related: ['vendor-list', 'vendor-statuses', 'supplier-signin'],
    body: `1. Go to **Vendors** and click **+ New vendor**.
2. Enter the vendor name, type (Domestic, Import or Government) and the contact's name, email and mobile.
   In a Gulf workspace, choose the **Supplier's language** too (English or Arabic) — it sets the invitation, portal and emails. See [Arabic for suppliers](#supplier-language).
3. Leave **Email the invite link to the contact now** ticked and click **Create & notify contact**.

@video(/help/a-invite.mp4 | Inviting a vendor)

The vendor appears as **Invited** with a code such as VND-00012. If the email didn't arrive, open the vendor and click **Resend invite** (possible until they submit). VendorGate warns you if a vendor with the same name already exists.

## Filling in for the supplier
For a supplier who sends their details by email or can't use the portal, open their page and click **Fill in for supplier** (while they're Invited, In progress or Sent back). Edit any tab, upload documents on the Documents tab and **Save**. Then either:
- **Save & close** — the supplier sees what you entered when they open their invitation, checks it and submits; or
- **Submit for approval…** — once everything required is there, tick that the supplier gave you these details and was shown the privacy notice. The approval flow starts as if they had submitted. The audit log shows you did it for them.

## Suppliers from Excel
**Vendors → Import from Excel** has two tabs:
- **Invite suppliers**: download the template, add one row per supplier (name, type, contact, and whether to send the invitation now), upload. Every row is checked first; nothing is created until the whole file is clean.
- **Import approved suppliers**: for your existing supplier master. The template has a column for every field on your form, plus the ERP supplier code. Rows become **approved** suppliers straight away, with no approval steps. Wrong values (an invalid GSTIN, a choice that isn't on the list) stop the import with their row number; missing details and documents are shown as warnings. Optionally email each supplier to sign in, check their details and upload what's missing.`,
  },
  {
    id: 'vendor-list', title: 'Finding vendors', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Status counts, search, Needs attention and the Waiting on column.',
    screens: ['^/staff/vendors/?$'],
    keywords: 'vendors list find search filter status count needs attention waiting on code email',
    related: ['vendor-statuses', 'invite-vendor', 'document-expiry'],
    body: `The **Vendors** page shows a count for each status across the top. Click one to filter; click **All** to clear.

![The Vendors page](/help/07-vendors.jpg)

- **Search** by name, vendor code or email.
- **Waiting on** shows who has the next move: the vendor, or the review level.
- **Needs attention** lists approved vendors with something to deal with: an expiring document, a failed re-check, an open change request or an erasure request.

Click a row to open the vendor.`,
  },
  {
    id: 'vendor-statuses', title: 'What each vendor status means', audience: ['staff', 'supplier'],
    summary: 'Invited, In progress, Under review, Sent back, Approved, Rejected, On hold.',
    screens: ['^/staff/vendors/'],
    keywords: 'status statuses invited in progress under review sent back approved rejected blocked on hold meaning lifecycle',
    related: ['review-decide', 'vendor-list'],
    body: `- **Invited**: the vendor has been created but the supplier hasn't opened the link yet.
- **In progress**: the supplier is filling in the form.
- **Under review**: submitted, and moving through the review levels in order.
- **Sent back**: a reviewer asked for corrections. The supplier fixes and resubmits, and it goes through the review levels again.
- **Approved**: every level approved. The vendor is active.
- **Rejected**: a reviewer rejected the registration, with a reason the supplier receives.
- **On hold** (blocked): an approved vendor temporarily stopped. See [Block and re-check](#block-recheck).`,
  },
  {
    id: 'review-decide', title: 'Reviewing and approving a vendor', audience: ['staff'], perms: ['vendors.view'],
    summary: 'My approvals, Approve / Send back / Reject, deadlines and reassigning.',
    screens: ['^/staff/queue', '^/staff/vendors/[^/]+$'],
    keywords: 'approve approval approvals reject send back decision review reviewer my approvals queue remarks deadline overdue sla escalation reassign assign',
    related: ['verification-checks', 'masked-data', 'config-workflow', 'out-of-office'],
    body: `**My approvals** lists the vendors waiting at a level you handle, or for a colleague you're covering for.

![My approvals](/help/10-my-approvals.jpg)

1. Open the vendor and check the profile tabs, documents, verification results and timeline.
2. Click **Approve**, **Send back to vendor** or **Reject** in the bar at the top.
3. Add remarks (required to send back or reject; the supplier receives them by email) and confirm.

![A vendor under review](/help/09-vendor-review.jpg)

@video(/help/c-approve.mp4 | Approving a vendor)

The **Approval flow** card on the right shows every level and its status. When a level's deadline passes, the step shows as overdue and its approvers get an escalation email. Users with *Reassign approval steps* can hand a waiting step to a specific person.`,
  },
  {
    id: 'self-registration', title: 'Become a supplier links (self-registration)', audience: ['staff'], perms: ['vendors.create', 'config.manage'],
    summary: 'Public links and QR codes suppliers use to apply; screening applications (accept or decline).',
    screens: ['^/staff/applications'],
    keywords: 'self registration register apply application applications become a supplier public link qr code website trade fair screen accept decline',
    related: ['invite-vendor', 'duplicates'],
    body: `Suppliers can apply without an invitation through a **“Become a supplier” link**.

**Links** (Vendors → Applications → *Registration links*, needs *Edit onboarding configuration*): make one per place you share it — your website, an email signature, a trade fair. Each has its own **QR code** (PNG, or SVG for print), an optional message for the page, an optional fixed vendor type, and who to email about new applications. *Turn off* closes a link; its page then says it is closed.

**What applicants do**: they give their company name, contact, mobile, the main registration number for your country (GSTIN, CR…), website and what they supply, then confirm their email with a 6-digit code. Nothing reaches you until the email is confirmed, and nothing becomes a supplier until you accept.

**Screening** (Vendors → **Applications**, needs *Invite vendors*): each application shows the link it came from, and warns about a supplier with the same name, contact email or registration number (the duplicate check), or an earlier application.
- **Accept** creates the supplier with what they gave and emails them a link to complete registration — then your normal onboarding and approval follow. You can correct the name or vendor type first.
- **Decline** records a reason and, if you choose, emails the applicant.`,
  },
  {
    id: 'corrective-actions', title: 'Corrective actions', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Ask a supplier to fix something by a date, from VendorGate’s suggestions or your own, and accept or reject their evidence.',
    screens: ['^/staff/actions', '^/staff/vendors/[^/]+$', '^/staff/risk'],
    keywords: 'corrective action capa remediation fix evidence due date overdue condition of approval suggest hold',
    related: ['risk', 'pre-review'],
    body: `Open a supplier → **Corrective actions** → **Raise corrective actions**. VendorGate suggests actions from what it found — a questionnaire knock-out answer, a registration that is no longer active, an expired certificate, a scorecard below 70, a name on record that doesn't match. Tick the ones to send, edit the wording, priority and due date, or add your own. The supplier is emailed once with all of them.

- **Who can raise them:** people with *Raise corrective actions on suppliers and review their evidence*, and the approvers of a supplier under review.
- **During review** actions are **conditions of approval**: the supplier can be approved, and must still complete them.
- **The supplier answers** with a note and files. Whoever raised the action (or anyone allowed to manage corrective actions) **accepts and closes** it, or **asks for more** with remarks. You can change the due date or cancel an action.
- **Reminders** go to the supplier before the due date and when overdue (the person who raised it is told too). Overdue actions add to the supplier's **risk score**; under Risk → *Monitoring settings* you can also **put the supplier on hold** when a high-priority action is overdue.

Vendors → **Corrective actions** lists every action: open, evidence to review, overdue, raised by you, closed.`,
  },
  {
    id: 'sourcing-settings', title: 'Sourcing settings', audience: ['staff'], perms: ['tenant.settings'], feature: 'sourcing',
    summary: 'Switch Sourcing (RFQs and e-auctions) on, choose formats and options, and set the rules every event starts with.',
    screens: ['^/staff/admin/sourcing'], contexts: ['sourcing-settings'],
    keywords: 'sourcing rfq auction reverse auction e-auction tender bid settings formats lock rules decrement extension',
    related: ['sourcing'],
    body: `Administration → **Sourcing** decides what buyers can do. Settings work in layers, and each layer can only narrow the one above:

1. **Your plan or licence** includes Sourcing and some or all of its formats (Integratatech switches this on).
2. **Switch Sourcing on** for the workspace. When it is off there are no Sourcing menus, screens or emails — your choices are kept.
3. **Formats**: sealed bid / RFQ and reverse auction today; forward, Japanese and Dutch auctions are shown as *coming later*.
4. **Options**: each capability on or off — outside bidders, two-envelope bids, clarifications, auto-extension, technical scoring, award letters, sending awards to the ERP and more. Some need another part of your plan (for example ERP integration).
5. **Rule defaults**: what bidders see, the minimum bid step, auto-extension minutes, envelopes, how many people must open sealed bids. **Lock** a rule so buyers can't change it for an event.
6. **Event approval**: levels like the onboarding approval flow — each handled by a role, optionally only when a rule holds (estimated value, format, category), with a deadline. By default: Finance above 10 lakh, and senior management above 1 crore. If no level applies, the event is approved straight away. Use *Test the flow* to try a value.
7. **Award approval**: a separate flow for awards — rules can use the award value and *not best price* (anything not all to the lowest price). By default: Finance above 10 lakh, and senior management above 1 crore or when the award isn't all to the best price.

> Changing a setting never changes an event that has already been published — each event keeps the rules it was published with. Every change is in the audit log.

People also need permissions (Administration → Roles): *View sourcing events*, *Create sourcing events*, *Opening committee*, *Evaluate bids*, *Control live auctions*.`,
  },
  {
    id: 'sourcing', title: 'Sourcing events', audience: ['staff'], perms: ['sourcing.view'], feature: 'sourcing',
    summary: 'RFQs and e-auctions with your approved suppliers and invited bidders.',
    screens: ['^/staff/sourcing'], contexts: ['sourcing'],
    keywords: 'sourcing rfq auction reverse auction e-auction tender bid event quotation',
    related: ['sourcing-settings'],
    body: `Sourcing → **Events** lists every RFQ and auction in your workspace with its status, number of bidders and closing or start time.

- **Sealed bid / RFQ**: bidders send one offer before a deadline; offers stay sealed until the opening committee opens them.
- **Reverse auction**: suppliers bid prices down during a live window; the lowest (L1) wins. Bidders never see each other's names.

Tabs: all events, waiting for approval, drafts, approved, your own, and **templates**. **+ New event** asks for a title and format; the number is given straight away (RFQ-2026-0001, RA-2026-0001 — one series per format, restarting each year).

Which formats and options are available is set by your administrator in [Sourcing settings](#sourcing-settings). See [Setting up an event](#sourcing-event).`,
  },
  {
    id: 'sourcing-event', title: 'Setting up a sourcing event', audience: ['staff'], perms: ['sourcing.view'], feature: 'sourcing',
    summary: 'Details, schedule, terms, rules, lots and items (or Excel), then submit for approval.',
    screens: ['^/staff/sourcing/events/'], contexts: ['sourcing-event'],
    keywords: 'sourcing event rfq auction lot item excel import template approval submit withdraw cancel terms rules award split winner letter regret savings erp',
    related: ['sourcing', 'sourcing-settings'],
    body: `A new event is a **draft**. Fill in:

- **Details**: title, estimated value (never shown to bidders — it decides who approves), category, and a description for bidders.
- **Schedule**: an RFQ has a bid deadline; an auction has a start and end, and optionally a sealed round that closes before it.
- **Terms**: pick standard terms (Administration → Agreements, *used for sourcing events*) and add anything specific to this event.
- **Rules**: start from your workspace's defaults; locked rules can't be changed.
- **Lots and items**: add them on screen, or **Import from Excel** — download the template, one row per item, rows with the same lot number form a lot. You see what was read (and any row errors) before anything is saved.

The box at the top lists anything missing. **Submit for approval** freezes the rules and sends the event through the approval levels; each approver is emailed. They can approve, send back (it becomes a draft again with their remarks) or reject. The owner of an event can never approve it. While it waits you can **withdraw** it to make changes.

**Bidders**: *+ Add suppliers* lists approved suppliers — those in the event's category first, then by lower risk and better scorecard; suppliers on hold (or, if your administrator chose, with overdue corrective actions) can't be picked. *+ Outside bidder* invites a company that isn't a supplier yet: they confirm their email with a code and give their registration number and what they supply; full onboarding is asked for only if they win. You can pick bidders while drafting; **Send invitations** once the event is approved (and again for anyone added later, until bidding closes). Bidders accept the terms and declare any conflict of interest, or decline with a reason — you're emailed either way. Bidders never see each other's names.

**Sealed offers**: bidders who accepted send their offer before the deadline — prices per item or per lot, tax, delivery, validity, payment terms, remarks and files; with two envelopes the technical part is separate. Each bidder gets a receipt reference. You only see who sent what — never the content — until the **opening committee** (people with *Be on the opening committee*) opens it after the deadline: each member confirms, and it opens when the event's quorum is reached.

**Two envelopes**: add the technical scoring sheet (weighted criteria and a pass mark) while drafting. After the technical envelopes are opened, evaluators score each bidder 0–10 per criterion; **Finish technical evaluation** qualifies bidders at or above the pass mark (you can decide differently, with a reason) and tells them. Only qualified bidders' commercial envelopes are opened. The **comparison** ranks prices per lot (L1 = lowest). For a reverse auction you can set each lot's start price from the best sealed price.

**Live reverse auction**: between the start and end time, bidders who accepted (and qualified, if there was a sealed round) bid prices down. Each bid must be at least the minimum step below the bidder's own last bid, and the first bid can't be above the lot's start price. Equal bids: the earlier one ranks higher. A bid much lower than the current best must be confirmed by the bidder. A bid in the last minutes extends the end (auto-extension). The **Live auction** panel shows the time left, each lot's ranking with names, savings against the start price and the target, and every bid. People with *Control live auctions* can **pause** and **resume** (the end moves out by the pause), **extend** with a reason, **message all bidders**, and **strike out** an obvious typing mistake — one person asks with a reason, a different person confirms; the bid stays in the history. The bid history is tamper-evident: **Verify history** checks that nothing was changed, and **Download CSV** gives the full log. Bidders see only their own rank (or, if your administrator chose, the best price or all prices) — never names.

**Award**: once prices are opened (RFQ) or the auction has closed, the **Award** section lists each lot's prices, best first, with payment terms and delivery. The lowest price is picked for you; to award to someone else or **split** a lot (for example 60% / 40%), enter the shares — they must add up to 100%. Anything not all to the best price needs a reason. **Propose award** sends it through the award approval flow (the person who proposed it can't approve it); approvers can approve, send back or reject, and you can withdraw it while it waits. When it is final: winners get an award letter and the others a thank-you letter (if award letters are on); a winner who isn't a supplier yet is asked to complete full registration; the award goes to your ERP for approved suppliers straight away and for new suppliers once they are approved. The section shows the winners, ERP message status and the saving against your estimate and the start price.

**Clarifications**: bidders' questions come to you by email; your answer — or an announcement — goes to every bidder without saying who asked.

- **Save as template** keeps the terms, rules and items for next time; **Sourcing → Templates → Use template** starts a new event from it.
- **Cancel event** needs a reason; drafts that were never submitted can simply be deleted.`,
  },
  {
    id: 'bidding', title: 'Taking part in a sourcing event', audience: ['supplier'], feature: 'sourcing',
    summary: 'Read the event and its terms, accept or decline the invitation, and ask questions.',
    screens: ['^/vendor/events'], contexts: ['bidding'],
    keywords: 'rfq auction bid quotation invitation event terms accept decline question clarification award result won',
    body: `**Sourcing events** lists every request for quotation and auction the buyer has invited you to, with when bidding closes.

Open an event to see what is being bought (lots and items), the description and the terms. Then:

- **Accept**: tick that you accept the terms and say whether you have a conflict of interest. You will submit your offer on the same page.
- **Decline**: tell the buyer why. You can change your answer until bidding closes.
- **Questions**: ask the buyer anything about the event. Answers are shared with every bidder without saying who asked.
- **Your offer**: before the deadline, enter your prices (per item or per lot), tax, delivery, validity, payment terms, remarks and files, and submit. You get a receipt reference by email. The offer stays sealed — the buyer can't see it until their opening committee opens all offers after the deadline. Where allowed, you can revise or withdraw it until the deadline. With two envelopes, send the technical envelope (no prices) and the commercial envelope separately.

**Live auctions**: a panel shows the time left (the server's clock) and, per lot, your rank and your best bid. Enter a bid at or below *Your next bid* — each bid must be at least the minimum step below your own last bid — and press **Place bid**. If a bid is much lower than the current best you are asked to confirm it, in case of a typing mistake. A bid in the last minutes extends the auction. Messages from the buyer appear on the panel and by email. You get a reminder a day and an hour before the start.

Other bidders see you only as "Bidder 1", "Bidder 2"… — names are never shown.

**Result**: when the buyer has finalised the award, the event page shows what you were awarded (lot, share and amount) — or that your offer was not selected — and you get a letter by email. You never see other bidders' results.

If you were invited without being a supplier yet, first give your registration number and what you supply. Full registration is asked for only if you win.`,
  },
  {
    id: 'pre-review', title: 'Pre-review for approvers', audience: ['staff'], perms: ['vendors.view'],
    summary: 'What VendorGate (and optionally AI) found about a submission, a recommendation and questions for the supplier.',
    screens: ['^/staff/vendors/[^/]+$', '^/staff/admin/integrations'],
    keywords: 'pre-review prereview ai summary recommendation approve review send back findings questions approver',
    related: ['review-decide', 'risk', 'duplicates'],
    body: `When a supplier is submitted, approvers find a **Pre-review** at the top of the supplier's page. It lists what VendorGate found, most serious first, each with a link to the tab it concerns:

- required items still missing (if the form changed since),
- verifications that failed, weren't run, or where the name on record doesn't match,
- documents that disagree with the form (“the form says … but the GST certificate shows …”) and documents expiring soon,
- possible duplicates, serious risk findings, high-risk questionnaire answers, and earlier send-back remarks.

It gives a recommendation — **Looks ready to approve**, **Check before approving** or **Send back to the supplier** — and questions for the supplier. **Send back with these questions…** opens *Send back* with them filled in.

**AI summary** (Administration → Integrations, *Write an AI summary for approvers*): the AI also writes a short summary and may add points the checks miss (for example answers that don't fit together). The recommendation is never softer than the findings call for.

**Privacy mode** — the only way the AI is used:
- The AI gets only general facts: choices from the form's fixed lists, company age and turnover, which documents exist and whether they are valid, each check as passed / failed / not run, questionnaire risk bands and multiple-choice answers, agreements accepted or not.
- **Amounts** go as ranges (“10–100 million INR”) or, if you choose *Exact* under Integrations, as exact figures — still with no name attached.
- **Comparisons worked out by VendorGate**: does the GSTIN's state match the address, does the PIN code match the state, does the PAN's holder type fit the type of entity, does the bank account holder name match the company, does the email domain match the company or website. The AI gets only yes / no. Any that don't fit also appear as findings, with or without the AI.
- **Compared with your suppliers**: where turnover, company age and requested payment terms sit among your approved suppliers of the same type and category (“higher than 85% of them”) — only when there are at least 5 to compare with.
- Names become placeholders — the supplier is [SUPPLIER], matching suppliers [OTHER-1]… — and VendorGate puts the real names back in what the AI writes.
- No names, numbers (bank, tax, registration), addresses, emails, phone numbers, typed-in answers, remarks or document contents are sent. Before sending, VendorGate checks the data against everything in the supplier's record and refuses to send if anything matches.
- **What the AI saw** on the pre-review shows exactly what was sent.

The pre-review is advisory — the approver decides. When the supplier's details change, it shows **out of date**; click *Refresh*.`,
  },
  {
    id: 'risk', title: 'Risk scores and ongoing monitoring', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Each supplier’s risk score, what drives it, re-checks of registration and sanctions, alerts and automatic hold.',
    screens: ['^/staff/risk', '^/staff/vendors/[^/]+$'],
    keywords: 'risk score monitoring high medium low sanctions gst cancelled registration hold alert bank change fraud re-check',
    related: ['duplicates', 'questionnaires', 'block-recheck', 'scorecards'],
    body: `**Vendors → Risk** lists approved and under-review suppliers by risk score (0–100). The score adds up what VendorGate already knows: failed verifications, possible duplicates, recent or frequent bank changes, a recent contact-email change, questionnaire results, expired documents, a scorecard below 70 and agreements not accepted. **Low** is below 25, **Medium** 25–49, **High** 50 or more.

**Serious findings** make a supplier High straight away: registration (GSTIN, CR, TRN) cancelled, suspended or not found; a possible sanctions match; an approved supplier sharing a bank account with another supplier.

**Monitoring**: approved suppliers' registration status and sanctions screening are re-checked automatically — every 30 days by default (*Monitoring settings*, needs *Workspace settings*). The supplier page shows a **Risk** card with the score and reasons; *Re-check now* runs the checks straight away (needs *Block vendors*).

**When a supplier turns High** the people you chose (or everyone who can block vendors) are emailed, the vendor list shows **High risk**, and the history records it. With **automatic hold** switched on, a serious finding also puts the supplier on hold — payment and purchase-order hold in the ERP — until someone reviews and unblocks it.

**Bank changes**: a change request with new bank details shows a **bank change risk** to the approver — the account of another supplier, a recent contact-email change, a supplier approved less than 30 days ago, a second change within 6 months, a bank in another country, or an account holder who isn't the supplier. Call the supplier on the number you already have before approving.

Suppliers never see risk scores.`,
  },
  {
    id: 'questionnaires', title: 'Supplier questionnaires and risk scores', audience: ['staff'], perms: ['config.manage', 'vendors.view'],
    summary: 'ESG, information security, quality, anti-bribery — asked by category, scored into Low / Medium / High risk.',
    screens: ['^/staff/admin/questionnaires', '^/staff/vendors/[^/]+$'],
    keywords: 'questionnaire questionnaires survey esg sustainability information security infosec quality iso anti-bribery category score risk band knock-out send yearly',
    related: ['agreements', 'scorecards', 'review-decide'],
    body: `Under **Administration → Questionnaires** (needs *Edit onboarding configuration*) build the questions suppliers answer in the portal. Start from a template — **ESG**, **Information security**, **Anti-bribery** or **Quality** — and change anything.

- **Asked of**: all suppliers, or only when a form answer matches — e.g. *Category of Supply is Services*, or a vendor type. Add your own categories as a dropdown in Configuration.
- **Required during onboarding**: suppliers can't submit for approval until they answer it.
- **Question types**: Yes / No, one choice, several choices, text, number, file upload. A question can be a **follow-up**, shown only for a given answer (“If yes, upload your ISO certificate”). Questions and answers can have Arabic wording.
- **Scoring**: each answer carries points (a file can too). The total as a % of the maximum gives the risk: **Low** at or above your Low threshold (75% by default), **Medium** at or above the Medium one (50%), **High** below. A **knock-out** answer (e.g. “Yes” to child labour) makes it High whatever the score.

**Suppliers** find a **Questionnaires** tab before Agreements. They can save and come back, then submit. They never see points or scores. A buyer filling in for a supplier can answer for them.

**Reviewers** see each questionnaire's answers with the score and risk on the supplier's page; knock-out answers are highlighted, and suppliers with a High result show **High-risk questionnaire answers** in the vendor list.

**Sending one later** (needs *Edit vendors*): on the supplier's page, Questionnaires → *Send questionnaire…*, optionally with a date to answer by — for example a yearly ESG review. The supplier is emailed; it starts from their last answers; the list shows **Questionnaire to answer** until they submit. Earlier answers stay on the page.

Editing a questionnaire only affects new answers — submitted ones keep the questions they answered.`,
  },
  {
    id: 'agreements', title: 'Agreements suppliers accept', audience: ['staff'], perms: ['config.manage', 'vendors.view'],
    summary: 'Code of conduct, NDA, supplier agreement: set them up, versions, accept again, certificates.',
    screens: ['^/staff/admin/agreements', '^/staff/vendors/[^/]+$'],
    keywords: 'agreement agreements code of conduct nda non-disclosure supplier agreement contract terms accept acceptance sign signature e-sign certificate version accept again signed copy',
    related: ['invite-vendor', 'review-decide', 'privacy'],
    body: `Under **Administration → Agreements** (needs *Edit onboarding configuration*) add what suppliers must accept — for example your **Supplier Code of Conduct** or an **NDA**.

- **Write the text** in VendorGate (with an optional Arabic version), or **upload your own PDF**.
- **Applies to**: Domestic, Import and/or Government suppliers (none ticked = all).
- **Required**: suppliers can't submit for approval until they accept it. Optional ones are offered only.

**In the portal** suppliers find an **Agreements** tab just before submitting. They read the agreement, tick *I agree*, and type their name and designation. VendorGate records the version, the date and time, the sign-in email, IP address and browser, and a fingerprint of the exact text or file. A **certificate of acceptance** (PDF) can be downloaded from the supplier's page.

**Filling in for a supplier** who signed on paper or by email: open the supplier, click *Fill in for supplier*, go to **Agreements**, enter who signed and attach the signed copy.

**New versions**: *New version* keeps every earlier version and who accepted it. Tick **Ask suppliers who accepted an earlier version to accept again** for real changes — approved suppliers are then emailed and show **Agreement to accept** in the vendor list until they do. Leave it off for small corrections. When you add a new agreement, *Also ask approved suppliers to accept it* does the same for your existing suppliers.

**Archive** stops asking for an agreement; past acceptances stay on record.`,
  },
  {
    id: 'duplicates', title: 'Possible duplicate suppliers', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Suppliers sharing a PAN, GSTIN, bank account, IBAN, CR or VAT number are flagged.',
    screens: ['^/staff/vendors'],
    keywords: 'duplicate duplicates same pan gstin bank account iban cr vat fraud not a duplicate group company possible duplicate',
    related: ['review-decide', 'change-requests', 'invite-vendor'],
    body: `VendorGate compares each supplier's identifiers with every other supplier in your workspace: **PAN** (including the PAN inside a GSTIN), **GSTIN**, **CIN**, **Udyam number**, **bank account** (with IFSC or SWIFT), **IBAN**, and in the Gulf the **CR**, **VAT / TRN** and trade licence numbers. Rejected suppliers are included, so a rejected supplier coming back under a new name is caught.

- A match shows as **Possible duplicate** in the vendor list and as a warning on the supplier's page, with links to the other suppliers.
- **Approving** a possible duplicate needs a tick: *I checked the possible duplicates and this is a separate supplier*. Each approver ticks it; it is kept in the history.
- **Change requests** that bring in another supplier's bank account or tax number are shown in red, and approving one needs confirmation that you checked with the supplier. This is the most common bank-detail fraud.
- **Not a duplicate…** (needs *Edit vendors*): when two suppliers really are different — group companies with one PAN, say — record why. The flag goes away for that pair and the reason is kept on both suppliers.
- **Import from Excel** stops on a row with the same GSTIN, bank account or other number as an existing supplier or another row. A shared PAN alone is a warning, since one company can have a GSTIN in several states.

Suppliers never see this — they aren't told that another supplier has the same details.`,
  },
  {
    id: 'verification-checks', title: 'Verification checks (GSTIN, PAN, bank, CIN)', audience: ['staff'], perms: ['vendors.view'], feature: 'kyc',
    summary: 'Check identifiers against official records, and read the name match.',
    screens: ['^/staff/vendors/[^/]+$'],
    keywords: 'verify verification verified check kyc gstin gst pan bank account penny drop cin mca name match not found invalid run re-run',
    related: ['review-decide', 'block-recheck'],
    body: `The **Verifications** card on a vendor shows the latest result for GSTIN, PAN, bank account and CIN / MCA.

- **✓ Verified**: found in official records. The name on record is shown with a match score; below 70% is flagged.
- **Not found** or **Invalid**: the number doesn't exist or isn't in the right format.
- **Try again**: the checking service didn't answer.

Click **Run** (or **Re-run**) beside a check to run it with the supplier's current answers. Identical checks are reused for 24 hours to save cost.`,
  },
  {
    id: 'masked-data', title: 'Masked data and Reveal', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Why PAN and bank numbers show as dots, and how to see them.',
    screens: ['^/staff/vendors/[^/]+$'],
    keywords: 'masked mask hidden dots reveal show full pan bank account number sensitive audit',
    related: ['audit-log', 'privacy'],
    body: `PAN, TAN, foreign tax IDs and bank account numbers show as \`••••1234\` to staff. Click **Reveal** beside a value to see it in full. Every reveal is recorded in the audit log with your name and the time.

Reports and exports keep these numbers masked too.`,
  },
  {
    id: 'change-requests', title: 'Change requests', audience: ['staff'], perms: ['vendors.view'],
    summary: 'How approved vendor details change: by the supplier or proposed by staff.',
    screens: ['^/staff/changes'],
    keywords: 'change request changes update edit modify bank details new account propose withdraw approved vendor correction',
    related: ['config-workflow', 'supplier-after-approval'],
    body: `An approved vendor's details are never edited directly. Each change is a **change request** that goes through the levels set under *Changes after approval*.

![Change requests](/help/14-changes.jpg)

- **Suppliers** request changes from their portal, for example new bank details with a cancelled cheque.
- **Staff** with *Propose changes* (Master Data Manager by default) click **Propose change** on the vendor's page. It's marked *by buyer*.
- Only one change request can be open per vendor.

Reviewers find waiting requests under **Change requests** (or the **Review change** bar on the vendor) and see old and new values side by side. The record changes only when every level approves.

![Reviewing a change on the vendor page](/help/14b-change-review.jpg)`,
  },
  {
    id: 'block-recheck', title: 'Block, unblock and re-check', audience: ['staff'], perms: ['vendors.block'],
    summary: 'Put an approved vendor on hold, and the yearly re-verification.',
    screens: ['^/staff/vendors/[^/]+$'],
    keywords: 'block unblock hold on hold suspend vendor stop recheck re-check periodic review reverify annual yearly',
    related: ['workspace-settings', 'verification-checks', 'erp'],
    body: `![An approved vendor](/help/13-approved-vendor.jpg)

## Block and unblock
Click **Block** on an approved vendor to put it on hold. A reason is required and goes in the audit log; choose whether to email the supplier. If an ERP connection is set up, the block is sent there too. **Unblock** reverses it.

## Periodic re-check
Approved vendors are re-checked automatically (every 12 months by default, set under Workspace). GSTIN, PAN, CIN and bank details are verified again, the supplier is asked to confirm their details, and problems are flagged under **Needs attention**. Click **Run re-check** to do it now.`,
  },
  {
    id: 'document-expiry', title: 'Document expiry reminders', audience: ['staff', 'supplier'],
    summary: 'Reminders 30 days and 7 days before, and on the day a document expires.',
    keywords: 'expiry expire expired expiring document certificate reminder renew renewal msme gst',
    related: ['config-documents', 'vendor-list'],
    body: `For documents that carry an expiry date, VendorGate emails the supplier 30 days and 7 days before, and on the day it expires. Expiring and expired documents of approved vendors also appear under **Needs attention** and in the **Expiring documents** report.

Suppliers renew a document by sending a change request with the new file.`,
  },

  /* ---------------- Insight ---------------- */
  {
    id: 'dashboard', title: 'Dashboard', audience: ['staff'], perms: ['reports.view'],
    summary: 'Headline numbers, onboarding funnel, turnaround and monthly trend.',
    screens: ['^/staff/dashboard'],
    keywords: 'dashboard kpi numbers chart funnel turnaround median days overdue trend analytics',
    related: ['reports'],
    body: `The **Dashboard** shows how onboarding is going for the period you choose (top left).

![The Dashboard](/help/15-dashboard.jpg)

- **Headline numbers**: vendors approved, median days from invite to approval, open registrations, overdue approval steps, active vendors and those needing attention. Click one to see the vendors behind it.
- **Onboarding funnel**: how many invited vendors started, submitted and were approved.
- **Turnaround**: time spent by vendors filling in versus time in internal review.
- **By month**: invitations and approvals over the last 12 months.`,
  },
  {
    id: 'reports', title: 'Reports and Excel downloads', audience: ['staff'], perms: ['reports.view'],
    summary: 'Vendor register, pending approvals, SLA breaches, turnaround and more.',
    screens: ['^/staff/reports'],
    keywords: 'report reports excel download export xlsx vendor register pending approvals sla breaches turnaround change requests expiring documents blocked erp deliveries',
    related: ['dashboard', 'audit-log'],
    body: `Pick a report on the left, set the filters, preview it, then click **Download Excel**. Every download is recorded in the audit log.

![The Reports page](/help/16-reports.jpg)

- **Vendor register**: all approved vendors (PAN and bank masked).
- **Pending approvals**: every step waiting for a decision, oldest first.
- **Deadline (SLA) breaches**: steps decided late, and steps overdue now.
- **Onboarding turnaround**: days from invite to approval.
- **Change requests**, **Expiring documents**, **Blocked vendors**, **ERP deliveries**.`,
  },
  {
    id: 'erp', title: 'ERP integration', audience: ['staff'], perms: ['tenant.settings', 'vendors.export'], feature: 'erp',
    summary: 'Send approved vendors to Oracle EBS, SAP S/4HANA, Dynamics 365, a webhook or CSV files.',
    screens: ['^/staff/admin/erp'],
    keywords: 'erp oracle ebs e-business suite webhook csv sftp export push sync integration test mode payload deliveries retry',
    related: ['block-recheck', 'reports'],
    body: `Administration → **ERP integration** sends approved vendors (and later changes, blocks and unblocks) to your ERP.

![ERP integration](/help/17-erp.jpg)

## Connectors
- **Oracle E-Business Suite**: creates and updates suppliers; needs the endpoint, credentials and operating unit (ORG_ID).
- **SAP S/4HANA**: creates the business partner with supplier roles, address, tax number, bank and company code through API_BUSINESS_PARTNER; needs the system URL and a communication user (scenario SAP_COM_0008 in the cloud edition).
- **Dynamics 365 Finance**: creates the vendor (VendorsV2) and its bank account; needs the environment URL, an Entra ID app registration (tenant, client id, secret) and the legal entity.
- **Webhook**: posts each vendor as JSON to your URL, signed with a secret.
- **CSV file**: one file per change, delivered to an SFTP folder or kept here for download.

## Go live safely
1. Keep **Test mode** on: nothing is sent, and **Preview payload** shows exactly what would be.
2. Click **Test connection**, then turn test mode off.
3. With **Push automatically** on, vendors are sent when approved or changed. Users with *Export vendors to ERP* can also push one by hand from the vendor's page.

**Recent deliveries** shows every push; click **Retry** on a failed one.`,
  },
  {
    id: 'privacy', title: 'Privacy and data protection (DPDP)', audience: ['staff'], perms: ['tenant.settings', 'vendors.view'],
    summary: 'Privacy notice, access requests, erasure and retention.',
    keywords: 'privacy dpdp gdpr consent notice personal data access request download erase erasure delete deletion retention grievance officer anonymise',
    related: ['audit-log', 'supplier-your-data', 'masked-data'],
    body: `- **Privacy notice**: under Workspace → *Privacy & data retention (DPDP)*. Suppliers accept it before filling the form; editing it creates a new version they accept again. Add your **Grievance officer email** here. Gulf workspaces also have a **Privacy notice in Arabic** for suppliers using the portal in Arabic.
- **Access request**: on a vendor's page, **Download personal data (access request)** gives a JSON file of everything held. Suppliers can download their own from their portal.
- **Erasure request**: when a supplier asks for deletion, the vendor appears under **Needs attention**. An administrator clicks **Erase personal data…** (reason required; can't be undone) or **Decline with reason…** when records must be kept by law.
- **Retention**: rejected registrations are erased after 365 days and abandoned ones after 180 days by default. Set 0 to keep.

Erasure replaces personal details with placeholders and deletes documents, but keeps the vendor code and audit trail.`,
  },
  {
    id: 'audit-log', title: 'Audit log', audience: ['staff'], perms: ['audit.view'],
    summary: 'Who did what, when and from where.',
    screens: ['^/staff/admin/audit'],
    keywords: 'audit log history trail activity who did what when ip record tracking compliance',
    related: ['masked-data', 'privacy', 'support-access'],
    body: `Administration → **Audit log** records every sign-in, decision, change, setting update, report download and reveal of masked data, with the person, time, details and IP address. Use **Older →** to page back.

![The Audit log](/help/19-audit.jpg)`,
  },

  /* ---------------- Your account ---------------- */
  {
    id: 'account-2fa', title: 'Two-factor authentication (2FA)', audience: ['staff'],
    summary: 'Turn on 2FA with an authenticator app; recovery codes; lost phone.',
    screens: ['^/staff/account'],
    keywords: '2fa mfa two factor two-step authenticator google microsoft authy otp code qr recovery codes lost phone security',
    related: ['password-sessions', 'workspace-settings', 'users'],
    body: `Click your name at the bottom left to open **My account**.

![My account](/help/20-account.jpg)

1. Click **Set up two-factor authentication**.
2. Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…), or type the key shown.
3. Enter the 6-digit code and click **Turn on**.
4. Save the 10 **recovery codes**. Each works once if you lose your phone.

From then on, every sign-in asks for a code after your password. If your workspace requires 2FA you can't turn it off.

> Lost your phone and your recovery codes? Ask an administrator to **Reset 2FA** for you under Users.`,
  },
  {
    id: 'password-sessions', title: 'Password and active sessions', audience: ['staff'],
    summary: 'Change your password and sign out other devices.',
    screens: ['^/staff/account'],
    keywords: 'password change new password sessions devices sign out other logout security',
    related: ['account-2fa', 'sign-in'],
    body: `## Change your password
Under **Password** on My account: at least 10 characters, using three of lowercase, uppercase, numbers and symbols. Other devices are signed out.

## Active sessions
Lists every device signed in to your account with its IP address and last activity. Click **Sign out other sessions** if you see one you don't recognise, then change your password.`,
  },
  {
    id: 'out-of-office', title: 'Out of office (delegate approvals)', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Let a colleague act on your approvals while you are away.',
    screens: ['^/staff/account'],
    keywords: 'out of office leave holiday vacation delegate delegation cover covering absent away backup',
    related: ['review-decide'],
    body: `On **My account → Out of office**, pick a colleague, the start and end, and an optional reason, then click **Set out of office**.

During that time they can approve, send back or reject everything waiting for you, and your items appear in their **My approvals**. Your own access doesn't change. Click **End** to stop early.`,
  },

  /* ---------------- Workspace-level ---------------- */
  {
    id: 'licence', title: 'Licence (on-premises installations)', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'See the licence of your own VendorGate installation, its limits and end date, and install a new one.',
    screens: ['^/staff/admin/licence'],
    keywords: 'licence license on-premises on-prem expiry renew read-only grace install users suppliers limit',
    related: ['plan-limits'],
    body: `If VendorGate runs on your company's own servers, it uses a **licence** from Integratatech instead of a subscription. **Administration → Licence** shows the customer, licence number, dates, how many staff users and suppliers it allows (and how many you use), and which features are included.

- **Renewing**: administrators are emailed 30, 14, 7 and 1 days before the end date. Choose the new licence file (or paste it) and click **Install licence** — it takes effect straight away.
- **After the end date** there is a grace period (normally 15 days) with a warning at the top of every screen.
- **After the grace period** VendorGate is **read-only** for staff: you can sign in and see everything, but not invite, approve or change anything until a new licence is installed. Suppliers can still use their portal, and the ERP integration and reminders keep running.

Your IT team can also install a licence from the server: \`./scripts/vg.sh licence install\`.`,
  },
  {
    id: 'plan-limits', title: 'Plan limits and free trial', audience: ['staff'],
    summary: 'User, vendor and email limits; what happens when a trial ends.',
    keywords: 'plan plans limit limits trial free trial ended expired upgrade users vendors emails per day feature not included subscription',
    related: ['users', 'troubleshooting'],
    body: `Each workspace is on a plan that sets how many users and vendors it can have, how many emails it can send a day, and whether ERP integration and AI document reading are included.

- When a limit is reached, VendorGate tells you which one; disable users who no longer need access, or contact VendorGate to raise it.
- On a **free trial**, a bar at the top shows the days left. When it ends you can still sign in and see everything, but adding vendors and users is paused until a plan is chosen. Nothing is deleted.`,
  },
  {
    id: 'support-access', title: 'Support access (yellow bar)', audience: ['staff'],
    summary: 'When VendorGate support views your workspace, read-only.',
    keywords: 'support access yellow bar read-only read only vendorgate team helpdesk viewing my workspace',
    related: ['audit-log'],
    body: `If you ask VendorGate support for help, they may open your workspace in **read-only** mode for up to 2 hours. A yellow bar at the top shows who is viewing, why and until when. They can look but not change anything, and each visit is recorded in your [Audit log](#audit-log).`,
  },
  {
    id: 'troubleshooting', title: 'Troubleshooting', audience: ['staff', 'public'],
    summary: 'Emails not arriving, sign-in problems, permission and limit messages.',
    keywords: 'problem problems error not working help troubleshoot issue email not received junk spam cannot cant login permission denied missing',
    related: ['sign-in', 'integrations', 'plan-limits'],
    body: `- **An invitation or code didn't arrive**: check Junk or Spam and mark it *Not junk*. Staff: **Resend invite**. Suppliers: request a new code (each lasts 10 minutes).
- **"Workspace, email or password is incorrect"**: check the workspace ID in your invitation email. After 5 wrong attempts wait 15 minutes or ask an administrator to **Unlock** you.
- **"You don't have permission to do this"**: your role doesn't include that action. Ask an administrator.
- **A vendor isn't in My approvals**: it's waiting at a level handled by another role, or already decided. Check the vendor's approval flow.
- **Can't edit an approved vendor**: use a [change request](#change-requests).
- **"Your plan allows…" or "trial ended"**: see [Plan limits and free trial](#plan-limits).
- **"This workspace is suspended"**: contact VendorGate. Your data is kept.`,
  },

  /* ---------------- Suppliers ---------------- */
  {
    id: 'supplier-signin', title: 'Signing in to the supplier portal', audience: ['supplier', 'public'],
    summary: 'Open your invitation link and enter the one-time code.',
    screens: ['^/onboard', '^/vendor/expired'],
    keywords: 'sign in login code otp one-time link invitation email sms expired session resend supplier vendor',
    related: ['supplier-privacy', 'supplier-fill', 'supplier-troubleshooting'],
    body: `You don't need a password.

1. Open the link in the invitation email from the buyer.
2. Click **Send code**. A 6-digit code is sent by email (or SMS, if the buyer set it up). It expires in 10 minutes.
3. Enter the code and click **Verify & continue**.

![The supplier sign-in page](/help/11-supplier-signin.jpg)

You stay signed in for up to 8 hours. To come back later, open the same link again.`,
  },
  {
    id: 'supplier-privacy', title: 'The privacy notice', audience: ['supplier'],
    summary: 'What you agree to before filling in the form.',
    screens: ['^/vendor'],
    keywords: 'privacy notice consent agree accept data protection dpdp personal data not now',
    related: ['supplier-your-data'],
    body: `The first time you sign in, the buyer's privacy notice explains what is collected, why, how it is checked and how long it is kept. Tick the box and click **Accept and continue** to start.

![The privacy notice](/help/12a-privacy.jpg)

If the buyer updates the notice, you'll be asked to accept the new version.`,
  },
  {
    id: 'supplier-actions', title: 'Corrective actions', audience: ['supplier'],
    summary: 'When the buyer asks you to fix something by a date: write what you did, attach evidence and send it for review.',
    screens: ['^/vendor'],
    keywords: 'corrective action fix evidence due date overdue remediation plan send review rejected more needed',
    related: ['supplier-guide'],
    body: `The buyer may ask you to fix something — for example after a questionnaire answer, a registration that is no longer active, or an expired certificate. You'll get an email, and the actions appear under **Corrective actions** in the portal.

- For each action, write **what you did** and **attach evidence** (a policy, certificate, plan or printout), then click **Send for review**.
- The buyer accepts it (the action is closed) or asks for more — their remarks are shown on the action; answer again.
- Each action has a **due date**. You'll get a reminder before it, and again if it is overdue. Overdue actions can affect your standing with the buyer.`,
  },
  {
    id: 'supplier-guide', title: 'Your guide: next step, checks and questions', audience: ['supplier'],
    summary: 'What to do next, what approvers would ask about before you submit, what to fix after a send-back, and asking a question.',
    screens: ['^/vendor'],
    keywords: 'guide next step what to do help question ask before submit check sent back fix remarks to do',
    related: ['supplier-fill', 'supplier-submit'],
    body: `**Your guide** on the right of the form shows the one thing to do next, with a button that takes you to the right tab.

- **Before you submit**, the confirmation lists what approvers would likely ask about — for example a document that shows a different value from the form, a PIN code from a different state, or a check that failed. Fixing these first avoids your registration being sent back. You can still submit as it is.
- **If your registration is sent back**, the guide turns the buyer's remarks into a to-do list, each point linked to the tab to fix.
- **Have a question?** Type it in the guide (for example “Why do you need a cancelled cheque?”). The answer comes from the help topics and from what each field of your form is for.

Your details are not sent to the AI: only what each field is for and whether it is filled in. Don't type your numbers or names into a question.`,
  },
  {
    id: 'supplier-fill', title: 'Filling in your details', audience: ['supplier'],
    summary: 'Sections, saving as you go, the required-fields checklist and AI suggestions.',
    screens: ['^/vendor'],
    keywords: 'fill form details company bank tax gst pan ifsc save next required fields checklist missing ai suggested values',
    related: ['supplier-documents', 'supplier-submit'],
    body: `Work through each tab (company, bank, tax and so on) and click **Save & next →**. Your answers are saved, so you can stop and come back.

@video(/help/b-supplier.mp4 | A supplier's first visit)

![The supplier portal](/help/12-supplier-portal.jpg)

- The **Required fields** list on the right shows what's still missing; click an item to jump to it.
- Where offered, click the check beside GSTIN, PAN or bank details to verify them on the spot.
- If AI document reading is on, click **Review suggested values →** after uploading, and pick which values to copy into the form.

## When the form fills itself in
Some buyers ask you to start with your documents. The **Documents** tab then comes first: upload everything, and the form is filled in from what we read.
- Documents marked **(if it applies to you)** depend on a question you haven't answered yet — for example, a GST certificate only if you hold a GST number. Upload them if they apply; that answers the question for you.
- Fields marked **✦ from …** were filled in from that document. Check them, and change anything that's wrong.
- Highlighted fields show what a document says but weren't filled in for you — bank and tax numbers always wait for you, as do values we couldn't read clearly. Click **Use this** to accept the value, or type your own.
- Anything you typed yourself is never overwritten. Add what no document shows (contacts, for example), then submit as usual.`,
  },
  {
    id: 'supplier-documents', title: 'Uploading documents', audience: ['supplier'],
    summary: 'File types, size limit, expiry dates and replacing a file.',
    screens: ['^/vendor'],
    keywords: 'upload document documents file pdf jpg png size 5 mb too large expiry certificate cheque replace',
    related: ['supplier-fill', 'document-expiry'],
    body: `Open the **Documents** tab and upload each required document. Files can be PDF, PNG or JPG, up to 5 MB each. Some documents ask for an expiry date; you'll be reminded before it runs out.

To replace a file before submitting, remove it and upload the new one. After approval, send a new document with a change request.`,
  },
  {
    id: 'supplier-submit', title: 'Submitting and tracking your approval', audience: ['supplier'],
    summary: 'Submit for review, see progress, and correct a sent-back form.',
    screens: ['^/vendor'],
    keywords: 'submit review approval progress status sent back corrections remarks rejected approved track waiting',
    related: ['vendor-statuses', 'supplier-after-approval'],
    body: `When nothing is left on the Required fields list, click **Review & submit**, then **Submit for review**.

**Approval progress** shows each review level and where your registration is. If a reviewer asks for changes, you'll get an email with their remarks: sign in, correct the form and submit again. When every level approves, you're notified and your portal says *You're approved and active as a vendor*.`,
  },
  {
    id: 'supplier-performance', title: 'Your performance scorecard', audience: ['supplier'],
    summary: 'How your buyer measures deliveries, order handling and invoices, if they share it with you.',
    screens: ['^/vendor/performance'],
    keywords: 'performance scorecard score grade on time delivery fill rate invoice accuracy late',
    body: `If your buyer shares it, **Performance** in the menu shows your score out of 100 and how it is worked out:

- **On-time delivery**: deliveries received on or before the promised date.
- **Fill rate**: how much of the ordered quantity you delivered on lines that fell due.
- **Order acknowledgement**: orders you accepted in the portal — accept new orders promptly rather than letting them be accepted automatically.
- **Invoice accuracy**: invoices that matched the order and deliveries first time.
- **Shipment notices**: deliveries you announced with a shipment notice.
- **Buyer rating**: your buyer's ratings of quality, delivery, service and communication.

**Late deliveries** lists the orders that arrived after the due date. Grades: A 90+, B 80+, C 70+, D below 70.`,
  },
  {
    id: 'supplier-after-approval', title: 'Updating your details after approval', audience: ['supplier'],
    summary: 'Request changes, withdraw a request, confirm your details at review time.',
    screens: ['^/vendor'],
    keywords: 'change update edit bank account new details request changes withdraw confirm details current periodic review',
    related: ['supplier-submit', 'supplier-your-data'],
    body: `- **Request changes**: edit what changed, add a reason and any supporting document, then **Send request**. The buyer reviews it; you can **Withdraw request** while it's pending. Only one request can be open at a time.
- **Confirm my details are current**: at each periodic review you're asked to confirm or update your details.`,
  },
  {
    id: 'supplier-your-data', title: 'Your data', audience: ['supplier'],
    summary: 'Download a copy, or withdraw consent and ask for deletion.',
    screens: ['^/vendor'],
    keywords: 'my data download copy export delete deletion erase withdraw consent privacy rights grievance',
    related: ['supplier-privacy'],
    body: `- **Download my data** gives you a copy of everything the buyer holds about you.
- **Withdraw consent & request deletion** asks the buyer to erase your data. Some records of approved suppliers must be kept by law, in which case the buyer will tell you why. Download your data first if you want a copy.`,
  },
  {
    id: 'supplier-portal-language', title: 'Using the portal in Arabic or English', audience: ['supplier'],
    summary: 'Switch language from the top bar; emails follow your choice.',
    screens: ['^/vendor', '^/s/', '^/onboard'],
    keywords: 'language arabic english العربية switch change rtl hijri date email sms',
    related: ['supplier-sign-in', 'supplier-fill'],
    body: `Where your customer offers it, you can use the supplier portal in **English or Arabic**.

- Click the language button in the top bar (**العربية** or **English**) at any time. On the sign-in page the same button is above the form.
- Your choice is remembered: sign-in codes, emails and SMS from the portal come in the same language.
- In Arabic, dates show the Hijri date beside the Gregorian one. Enter dates as Gregorian in date boxes.
- Answers you type in Arabic are kept as typed. Choices such as a legal form are stored the same way in both languages, so switching never changes your answers.

![An order in Arabic](/help/21-arabic-portal.jpg)`,
  },
  {
    id: 'supplier-troubleshooting', title: 'Supplier troubleshooting', audience: ['supplier', 'public'],
    summary: 'Code not received, link expired, upload refused.',
    screens: ['^/onboard', '^/vendor'],
    keywords: 'problem code not received expired link junk spam upload failed file too large session expired signed out',
    related: ['supplier-signin', 'supplier-documents'],
    body: `- **No code arrived**: check Junk or Spam, then click **Resend code**. Codes last 10 minutes.
- **"Code expired"**: request a new one; 5 wrong tries also expire a code.
- **Signed out**: sessions last 8 hours. Open your invitation link again.
- **Upload refused**: only PDF, PNG or JPG up to 5 MB.
- **Link no longer works**: ask the buyer to resend your invitation.`,
  },

  /* ---------------- Platform console ---------------- */
  {
    id: 'platform-workspaces', title: 'Creating and managing workspaces', audience: ['platform'],
    summary: 'New workspace, administrators, notes and usage.',
    screens: ['^/platform/?$', '^/platform/tenants'],
    keywords: 'workspace workspaces tenant tenants customer create new add administrator admin invite usage notes',
    related: ['platform-plans', 'platform-suspend', 'platform-support'],
    body: `**Workspaces → New workspace**: company name, workspace ID (suggested and checked as you type), the administrator's name and email, and the plan. The administrator gets an invitation email.

On a workspace's page you can see usage against plan limits, change the plan and limits, add an administrator for a customer who lost access, resend invitations and keep internal notes.`,
  },
  {
    id: 'platform-plans', title: 'Plans and limits', audience: ['platform'],
    summary: 'Trial, Standard, Enterprise, and per-workspace overrides.',
    screens: ['^/platform/tenants/'],
    keywords: 'plan plans trial standard enterprise limit limits override users vendors emails features erp ai',
    related: ['platform-workspaces'],
    body: `- **Trial**: 5 users, 25 vendors, 200 emails a day, no ERP or AI.
- **Standard**: 25 users, 1,000 vendors, 2,000 emails a day, all features.
- **Enterprise**: no limits.

Under **Plan and limits** leave a box empty to use the plan's value, or type **unlimited** to remove that limit for one workspace. Features can be switched on or off per workspace. Changes apply at once.`,
  },
  {
    id: 'platform-suspend', title: 'Suspending a workspace', audience: ['platform'],
    summary: 'Sign everyone out and block access, keeping the data.',
    screens: ['^/platform/tenants/'],
    keywords: 'suspend suspended reactivate block unpaid close disable workspace tenant',
    related: ['platform-workspaces'],
    body: `**Suspend…** on a workspace signs out every user and supplier and blocks sign-in. A reason is required and you type the workspace ID to confirm. Nothing is deleted; **Reactivate** restores access.`,
  },
  {
    id: 'platform-support', title: 'Read-only support access', audience: ['platform'],
    summary: 'Look at a customer workspace to help them, audited.',
    screens: ['^/platform/tenants/'],
    keywords: 'support access impersonate view as customer read only troubleshoot ticket',
    related: ['platform-workspaces'],
    body: `**Support access…** opens the workspace as its administrator sees it, read-only, for 15 minutes to 2 hours. Give a reason; it's recorded in the customer's own audit log, and they see a yellow bar while it's open. Click **End support access** on that bar when done.`,
  },
  {
    id: 'platform-signup', title: 'Self-service sign-up', audience: ['platform'],
    summary: 'Open the /signup page, choose the plan and trial length.',
    screens: ['^/platform/settings', '^/platform/signups'],
    keywords: 'signup sign up self service register trial work email free email gmail terms notify',
    related: ['platform-plans'],
    body: `Under **Sign-up settings**, turn on **Allow self-service sign-up** and choose the plan, trial length, notification email and terms link. Companies then sign up at /signup, confirm their email, and get a workspace straight away.

**Work email addresses only** rejects Gmail, Outlook.com, Yahoo and disposable addresses. **Sign-ups** lists every attempt and whether the email was confirmed.`,
  },
  {
    id: 'platform-admins', title: 'Platform admins and security', audience: ['platform'],
    summary: 'Invite colleagues, reset 2FA, and what to do if locked out.',
    screens: ['^/platform/admins', '^/platform/audit'],
    keywords: 'platform admin admins invite colleague 2fa reset locked out audit',
    related: ['platform-workspaces'],
    body: `Everyone with platform access can manage every customer, so keep the list short. Two-factor authentication is always required.

- **Invite admin** sends a 7-day link.
- **Reset 2FA** for a colleague who lost their phone; **Disable** removes access at once.
- The **Audit log** records every console action and sign-in.

Locked out entirely? Run \`npm run platform:admin -- --email you@company.com --reset-2fa\` against the database (see DEPLOY.md).`,
  },
  /* ---------------- Purchase orders (supplier collaboration) ---------------- */
  {
    id: 'orders-overview', title: 'Purchase orders: how it works', audience: ['staff'], perms: ['orders.view', 'orders.manage'], feature: 'collab',
    summary: 'Orders come from your ERP, suppliers accept them in the portal, acceptance goes back to the ERP.',
    screens: ['^/staff/orders/?$'], contexts: ['orders'],
    keywords: 'po purchase order supplier collaboration acceptance acknowledge confirm oracle ebs erp waiting',
    related: ['orders-getting-in', 'orders-acceptance', 'orders-unlinked', 'purchasing-groups'],
    body: `Purchase orders let your suppliers see and accept the orders you place with them, without email back-and-forth.

1. Your ERP sends each order to VendorGate (see [Getting orders in](#orders-getting-in)).
2. The order is linked to a vendor by its **supplier code**, and everyone with access at that supplier gets an email.
3. The supplier accepts the whole order or individual lines in the supplier portal.
4. The acceptance is sent back to your ERP through the connection under **ERP integration**.

## The tiles
- **Waiting for supplier** — at least one open line hasn't been accepted.
- **Auto-accept within 2 days** — waiting orders that will accept themselves soon.
- **Accepted / Auto-accepted** — confirmed by the supplier, or accepted because the buying group's waiting time passed.
- **Closed / cancelled** — closed or cancelled in the ERP.

> If the ERP changes the quantity, price, need-by date or item on a line, that line goes back to waiting and the supplier is asked to accept it again.`,
  },
  {
    id: 'orders-getting-in', title: 'Getting orders in from the ERP', audience: ['staff'], perms: ['orders.manage', 'tenant.settings'], feature: 'collab',
    summary: 'Oracle EBS pull, the REST API, CSV import and sample orders.',
    contexts: ['orders', 'purchasing-keys'],
    keywords: 'import csv api oracle pull sync nightly get from erp sample demo template po_headers_all webhook key',
    related: ['orders-overview', 'purchasing-keys', 'orders-unlinked'],
    body: `There are four ways to get orders in. Sending the same order again updates it rather than duplicating it.

## Oracle EBS
Under **ERP integration**, choose Oracle EBS and fill in **Purchase order pull URL** (an endpoint that returns PO_HEADERS_ALL with its lines and shipments) and **Acknowledgement URL** (where acceptances are posted). Orders are fetched every night; use **Get from ERP** on the Purchase orders page to fetch now.

## REST API
Your ERP or middleware can push orders to \`/api/v1/purchase-orders\` with an API key from [Purchasing setup → API keys](#purchasing-keys). Add \`?format=oracle\` to send Oracle rows as they are.

## CSV
**Import CSV** takes one row per order line. Download the template from the import window to see the columns.

## Sample orders
While the ERP connection is in test mode, **Load sample orders** creates a few Oracle-style orders for your approved vendors so you can try the supplier side.`,
  },
  {
    id: 'orders-unlinked', title: 'Orders for unlinked supplier codes', audience: ['staff'], perms: ['orders.manage'], feature: 'collab',
    summary: 'Link an ERP supplier code to a vendor so the supplier can see its orders.',
    contexts: ['orders'],
    keywords: 'unmapped unlinked supplier code vendor number link map not visible supplier cannot see order',
    related: ['orders-overview', 'supplier-access'],
    body: `Every order carries the ERP's **supplier code** (the supplier number in Oracle). An order is shown to a supplier only when that code is linked to one of your vendors.

Codes are matched automatically when they equal a vendor's VendorGate code or a code already linked to it. When nothing matches, the Purchase orders page shows a yellow banner.

1. Click **Link supplier codes**.
2. Pick the vendor for each code and click **Link**.

All waiting orders for that code are linked at once, and the supplier is emailed. You can also add codes from the vendor's page — see [Supplier portal access](#supplier-access).`,
  },
  {
    id: 'orders-acceptance', title: 'Accepting orders and auto-accept', audience: ['staff'], perms: ['orders.view', 'orders.manage'], feature: 'collab',
    summary: 'Line-level acceptance, recording acceptance for a supplier, reminders and the ERP message.',
    screens: ['^/staff/orders/[^/]+$'], contexts: ['order'],
    keywords: 'accept acceptance auto-accept automatic reminder record on behalf retry failed message erp acknowledgement payload',
    related: ['purchasing-groups', 'orders-overview'],
    body: `Suppliers can accept a whole order or only some lines. The order shows **Partly accepted** until every open line is accepted.

## Auto-accept
If the order's buying group has a waiting time, the order accepts itself when that time passes. Suppliers get a reminder a day before. Groups without a waiting time need the supplier to accept.

## Recording an acceptance yourself
If the supplier confirmed by phone or email, open the order and use **Record supplier acceptance**. Choose the lines and say how they confirmed. It's recorded under your name, on behalf of the supplier.

## Messages to the ERP
Each acceptance — and later each shipment notice and approved invoice — is sent to the ERP and listed under **Messages to the ERP**. **Payload** shows exactly what was sent. If sending failed, fix the cause (often the Acknowledgement URL or the ERP being down) and click **Retry**. "No ERP connection" means nothing is set up to receive acceptances — ERPs can still read them from \`/api/v1/acknowledgements\`.`,
  },
  {
    id: 'shipments', title: 'Shipment notices (ASN)', audience: ['staff'], perms: ['orders.view', 'orders.manage'], feature: 'collab',
    summary: 'What suppliers tell you is on the way, how receipts are matched, and cancelling a notice.',
    screens: ['^/staff/orders/[^/]+$'], contexts: ['order'],
    keywords: 'asn shipment notice dispatch delivery in transit received receipt grn e-way bill carrier tracking cancel',
    related: ['orders-acceptance', 'supplier-invoices'],
    body: `Once a supplier has accepted goods lines, they can send a **shipment notice** for what is on the way: quantities per line (part of a line is fine), ship and expected dates, carrier, tracking and vehicle numbers, the e-way bill number in India, and batch numbers.

- A line can't be shipped beyond its ordered quantity plus the line's over-delivery tolerance.
- Each notice is sent to your ERP like an acceptance (see **Messages to the ERP**), and the buyer gets an email.
- **Receipts** your ERP reports (with the order import or \`POST /api/v1/receipts\`) are matched to the notices: a receipt that names the notice number goes to that notice, others go to the oldest open notice for the line. Notices show **In transit**, **Partly received** or **Received**.
- The supplier is emailed when goods on a notice are first received and again when it is complete.
- If the expected delivery date passes and the notice isn't fully received, you and the supplier each get one reminder the next morning, and the notice shows **Overdue**.
- A notice can be cancelled until goods on it are received. The supplier is told why.

**ASN required**: tick it on a buying group to ask suppliers for a notice on every delivery. Orders in that group show a reminder to the supplier and to you while none has been sent.`,
  },
  {
    id: 'supplier-invoices', title: 'Supplier invoices and matching', audience: ['staff'], perms: ['orders.view', 'invoices.manage'], feature: 'collab',
    summary: 'How invoices are matched to orders and receipts, exceptions, and approving or rejecting them.',
    screens: ['^/staff/invoices', '^/staff/payments'], contexts: ['invoices'],
    keywords: 'invoice supplier invoice three way match 3-way price tolerance exception approve reject e-invoice irn qr gstin duplicate payment remittance paid',
    related: ['shipments', 'purchasing-groups'],
    body: `Suppliers raise invoices from an accepted order (or a shipment notice). Each invoice is matched before it reaches you:

- **Quantity**: never more than ordered (plus tolerance) minus what's already invoiced — these are refused outright. For goods, invoicing more than has been received so far is flagged.
- **Price**: a unit price above the order price by more than your tolerance (Purchasing setup → **Invoice matching**, default 2%) is flagged.

![An invoice with exceptions under Matching](/help/22-invoice-matching.jpg)

- **Arithmetic and duplicates**: the lines and tax must add up to the invoice total; the same invoice number can't be submitted twice; the same date and amount under another number is flagged.
- **India e-invoice**: the IRN must be 64 characters. If the supplier pastes the signed QR text, its GSTIN, invoice number, IRN and value are compared with the invoice. (The QR's digital signature isn't verified.)

Clean invoices wait **In review**; flagged ones are **Exceptions**. Open **Supplier invoices**, check the **Matching** list, and **Approve** or **Reject**. Approving an exception needs a note; rejecting always needs a reason, which the supplier sees. Approved invoices are sent to the ERP and count against the order lines.

## Payments
When your ERP reports a payment (\`POST /api/v1/payments\`, with the invoices it settles), the invoices become **Partly paid** or **Paid** and the supplier gets a payment advice by email. **Payments** lists them all. You need the *Approve supplier invoices* permission to decide invoices and see payments.`,
  },
  {
    id: 'purchasing-groups', title: 'Buying groups', audience: ['staff'], perms: ['orders.view', 'orders.manage'], feature: 'collab',
    summary: 'Decide which orders the supplier must accept and when orders accept themselves.',
    screens: ['^/staff/admin/purchasing'], contexts: ['purchasing-groups'],
    keywords: 'buying group category auto accept days manual acceptance asn rule purchasing setup',
    related: ['orders-acceptance', 'purchasing-entities'],
    body: `Every order belongs to a buying group — the purchasing category or buyer team code your ERP sends. The group sets the acceptance rule:

- **The supplier must accept it** — the order waits until the supplier responds.
- **Accept automatically after N days** — if the supplier hasn't responded, the order accepts itself (calendar days from when it arrived).

Codes the ERP sends that you haven't set up are added automatically with manual acceptance. Changing a group's rule also re-times its orders that are still waiting.`,
  },
  {
    id: 'purchasing-entities', title: 'Companies and delivery sites', audience: ['staff'], perms: ['orders.view', 'orders.manage'], feature: 'collab',
    summary: 'The legal entities that place orders and the sites goods are delivered to.',
    contexts: ['purchasing-entities'],
    keywords: 'company legal entity operating unit site plant warehouse ship-to location',
    related: ['purchasing-groups'],
    body: `**Companies** are the legal entities that place orders (operating units in Oracle EBS). **Delivery sites** are the plants, warehouses and offices on each line's ship-to.

Both are created automatically from incoming orders using the ERP's codes; add them here first if you want friendlier names. Suppliers can filter their orders by company and site. Deactivating one hides it from new choices but keeps existing orders as they are.`,
  },
  {
    id: 'purchasing-keys', title: 'API keys for your ERP', audience: ['staff'], perms: ['tenant.settings'], feature: 'collab',
    summary: 'Create a key so your ERP or middleware can push orders and read acceptances.',
    contexts: ['purchasing-keys'],
    keywords: 'api key token bearer authorization rest endpoint integration middleware revoke',
    related: ['orders-getting-in'],
    body: `1. Go to **Purchasing setup → API keys**.
2. Enter a name (for example "Oracle EBS production") and click **Create key**.
3. Copy the key straight away — it is shown only once.

Send it with every request as \`Authorization: Bearer <key>\`. The endpoints are listed under the keys. **Revoke** stops a key immediately; create a new one first if you are rotating keys.`,
  },
  {
    id: 'supplier-access', title: 'Supplier portal access', audience: ['staff'], perms: ['vendors.view', 'orders.manage'], feature: 'collab',
    summary: 'Which people at a supplier can sign in, their ERP codes and the sign-in link.',
    keywords: 'supplier contact person access add email sign in link portal erp code remove access',
    related: ['orders-unlinked', 'supplier-sign-in'],
    body: `An approved vendor's page has a **Supplier portal** card.

- **ERP supplier codes** — orders with these codes are shown to this vendor. Adding a code links any orders already waiting under it.
- **Who can sign in** — the vendor's main contact, plus anyone you add. Each person signs in with their own email and a one-time code, sees this vendor's orders, and receives new-order emails. **Remove access** signs them out straight away.
- **Sign-in link** — share it with the supplier; it's the same for all your suppliers.`,
  },
  {
    id: 'supplier-sign-in', title: 'Signing in to the supplier portal', audience: ['supplier', 'public'],
    summary: 'Use your work email and a one-time code. Pick the company if you have more than one.',
    screens: ['^/s/', '^/vendor/expired'],
    keywords: 'sign in login code otp email not received choose company supplier portal',
    related: ['supplier-accept'],
    body: `1. Open the sign-in link your customer sent you (it ends in \`/s/\` and their workspace name).
2. Enter your work email and click **Send code**.
3. Type the 6-digit code from the email. It's valid for 10 minutes.

If your email has access to more than one supplier account, choose the company to work on.

> No code? Check spam, wait a minute and click **Resend code**. If it still doesn't arrive, your customer may have a different email on file — ask them to add you.`,
  },
  {
    id: 'supplier-accept', title: 'Accepting purchase orders', audience: ['supplier'], feature: 'collab',
    summary: 'Review an order, accept all or some lines, and add a note for the buyer.',
    screens: ['^/vendor/orders'], contexts: ['supplier-orders', 'supplier-order'],
    keywords: 'accept purchase order po confirm lines partial auto-accepted revised changed note buyer',
    related: ['supplier-sign-in'],
    body: `**Purchase orders** in the top bar lists the orders your customer has placed with you. The number next to it is how many are waiting for you.

1. Open an order and check the lines — quantity, price, delivery site and need-by date.
2. All waiting lines are ticked. Untick any you can't accept yet.
3. Click **Accept order** (or **Accept selected lines**), add a note if you like, and confirm.

Your acceptance is sent to the customer's system straight away.

## Good to know
- Some orders accept themselves after a few days if you don't respond. The order shows when.
- If the customer changes a line, it comes back to you as waiting.
- Anything wrong with an order? Use the buyer's email on the order to contact them before accepting.`,
  },
  {
    id: 'supplier-ship-invoice', title: 'Shipment notices, invoices and payments', audience: ['supplier'], feature: 'collab',
    summary: 'Tell the buyer what is on the way, raise invoices against an order, and see payments.',
    screens: ['^/vendor/orders/', '^/vendor/invoices', '^/vendor/payments'], contexts: ['supplier-order'],
    keywords: 'shipment notice asn dispatch delivery e-way bill invoice raise submit irn e-invoice qr withdraw rejected payment advice remittance paid',
    related: ['supplier-accept'],
    body: `## Shipment notices
After you accept an order, open it and click **Create shipment notice** when goods leave. Enter how much of each line is on this shipment (you can ship the rest later), the dates, carrier and tracking, vehicle and e-way bill numbers. The buyer is told straight away. You get an email when the buyer receives the goods (and when the whole shipment is in), and a reminder if the expected delivery date passes without a receipt. You can cancel a notice until the buyer has received the goods.

## Invoices
1. Open the order and click **Raise invoice** (choose the shipment if it's for one).
2. Enter the invoice number and date as printed, and the quantity, price and tax for each line. Attach the invoice PDF.
3. In India, if you e-invoice, enter the **IRN** and paste the text from the signed QR code.
4. Click **Check** to see how it matches the order, then **Submit invoice**.

You can't invoice more than ordered (less anything already invoiced). Prices above the order price or goods not yet received are allowed but the buyer will review them more closely. **Invoices** in the top bar shows where each one stands. You can **Withdraw** an invoice while it is in review; if one is rejected, the reason is shown and you can submit a corrected one with the same number.

## Payments
When the buyer pays, you get a payment advice by email and the invoices show **Paid** or **Partly paid**. **Payments** lists each payment with the invoices it covers and any tax withheld.`,
  },
  /* ---------------- Country rules (Saudi Arabia and the Gulf) ---------------- */
  {
    id: 'expiry-hold', title: 'Automatic hold when a document lapses', audience: ['staff'], perms: ['vendors.view', 'config.manage'],
    summary: 'Vendors go on hold when a key certificate or licence expires, and come off hold when the renewal is approved.',
    keywords: 'hold block expired lapsed zakat gosi nitaqat saudization cr confirmation certificate trade licence license renewal payment hold automatic uae bahrain',
    related: ['document-expiry', 'sanctions-screening'],
    body: `Some documents must stay valid for a supplier to keep being paid — in Saudi workspaces the CR (annual confirmation), Zakat, GOSI and Saudization (Nitaqat) certificates; in the UAE the trade licence; in Bahrain and Oman the CR; in Qatar the CR and commercial licence; in Kuwait the commercial licence.

## What happens
1. Reminders go to the supplier 30 and 7 days before the date, as for any document with an expiry.
2. On the day it lapses, the vendor is put **on hold** automatically. The ERP is told (payment hold), the supplier and your vendor admins are emailed, and the vendor shows **On hold — document expired**.
3. The supplier uploads the renewed document and submits it as a change request — they can do this even while on hold.
4. When the change request is approved, the hold lifts by itself and the ERP is told.

## Setting it up
In **Configuration → Documents**, open a document, tick **Track expiry date**, then **Put the vendor on hold when it lapses**.

> Holds you place yourself (Block) are never lifted automatically.`,
  },
  {
    id: 'sanctions-screening', title: 'Sanctions screening', audience: ['staff'], perms: ['vendors.view'],
    summary: 'Gulf workspaces screen every supplier and its listed owners against sanctions lists on submission and at each re-check.',
    keywords: 'sanctions screening ofac un eu uk list match aml compliance possible match clear',
    related: ['expiry-hold'],
    body: `In Saudi (and other Gulf) workspaces every supplier — its legal name and each owner listed on the Ownership tab — is screened against sanctions lists:

- automatically when they submit for review,
- again at every periodic re-check,
- and on demand with **Run** in the vendor’s **Verifications** card.

**Clear** means no match. **Possible match** means a reviewer must look at the details before approving — the result names who matched, the listed entity, how close the match is and which lists it is on. Most possible matches turn out to be similar names. Record your conclusion in the approval remarks.

Suppliers never see screening results.

> Admin → Integrations shows whether screening is live (OpenSanctions) or still answered from a test list.`,
  },
  {
    id: 'working-days', title: 'Deadlines in working days', audience: ['staff'], perms: ['tenant.settings', 'orders.manage'],
    summary: 'Approval deadlines and purchase-order auto-accept can skip the weekend.',
    contexts: ['purchasing-groups'],
    keywords: 'weekend working days friday saturday sunday deadline sla auto accept calendar business days',
    related: ['purchasing-groups'],
    body: `With **Count deadlines in working days** on (Admin → Workspace → Vendor lifecycle), the hours allowed for each approval level and the days before a purchase order auto-accepts don’t count the weekend.

- Saudi Arabia, Bahrain, Qatar, Kuwait and Oman: Friday and Saturday. UAE: Saturday and Sunday. It is on from the start in Gulf workspaces.
- Indian workspaces: Sunday. It is off unless you turn it on.

Deadlines already running keep their date; new approval steps and new orders follow the setting. Emails show deadlines in your own time zone (IST, AST…).`,
  },
  {
    id: 'supplier-hold', title: 'Your account is on hold', audience: ['supplier'],
    summary: 'Why your supplier account was put on hold and how to lift it.',
    screens: ['^/vendor'],
    keywords: 'on hold blocked expired certificate renew upload payment stopped',
    body: `If a required certificate (for example Zakat, GOSI, Saudization or your CR confirmation) passes its date, your account is put on hold and payments may pause.

1. Open the **Documents** tab.
2. Upload the renewed document and enter its new expiry date.
3. Submit it as a change request (**Request changes** → **Submit change request**).

The hold is lifted as soon as the renewal is approved. You’ll get an email.`,
  },
  {
    id: 'contracts', title: 'Contracts', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'Your supplier and customer contracts in one place: dates, value, renewal, notice and the signed copies.',
    screens: ['^/staff/contracts'], contexts: ['contracts'],
    keywords: 'contract contracts agreement nda msa sow repository renewal expiry expiring notice period signed copy terminate import excel',
    related: ['contract-drafting', 'contract-parties', 'contracts-settings'],
    body: `Contracts → **All contracts** lists every contract with its number, party, type, status, value and end date. Tabs: supplier contracts, customer contracts, **expiring** (ending within your workspace's warning period, soonest first), drafts and ended.

- **+ New contract**: choose supplier or customer, the type (the number comes from the type — NDA-2026-0001, MSA-2026-0001…), the party, value, dates, notice period and whether it renews automatically. A schedule or SOW can sit **under a master agreement** with the same party.
- **Already signed?** Tick *Already signed* to record a contract signed outside VendorGate — it becomes active (or expired, if its end date has passed).
- A **draft** becomes active with **Mark as signed**: upload the signed copy first, and the contract needs a start date. To write the contract in VendorGate, see [Drafting and approval](#contract-drafting).
- Once active, only the owner, description, category, notice period, renewal and reference can change. **Terminate** ends it early with a reason.
- **Files**: the signed copy, drafts, annexures and other papers, each kept with who uploaded it and when.
- **Import from Excel** brings in the contracts you already have — download the template, one row per contract; you see what was read and any errors before anything is saved. Tick *Create missing parties* to add suppliers or customers that aren't there yet.

Statuses: **Draft** → **In approval** → **Approved** → **Active** → **Expired** or **Terminated**.

Every night, contracts past their end date become **expired** — or, if they renew automatically, move on by the renewal term. Every change is in the contract's history.`,
  },
  {
    id: 'contract-parties', title: 'Contract parties', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'The suppliers and customers you have contracts with — light records, optionally linked to onboarded suppliers.',
    screens: ['^/staff/parties'], contexts: ['contract-parties'],
    keywords: 'party parties supplier customer counterparty contact signatory link onboard import excel duplicate',
    related: ['contracts'],
    body: `Contracts → **Parties** keeps a short record of each supplier and customer: name, legal name, country, registration and tax numbers, address, and contacts — tick **Signs** for the people who sign contracts.

- Codes are given automatically (SUP-00001 for suppliers, CUS-00001 for customers).
- If a new party looks like an existing one (same name, tax or registration number) you're asked before it is created.
- **Import from Excel** adds many at once; rows that look like an existing party are left out.
- When supplier onboarding is on, a supplier party can be **linked** to its supplier record — its status and risk then show on the party and its contracts. **Send for onboarding** invites the party to full supplier onboarding and links it straight away.
- A party with open contracts can't be archived.`,
  },
  {
    id: 'contracts-settings', title: 'Contracts settings', audience: ['staff'], perms: ['tenant.settings'], feature: 'contracts',
    summary: 'Switch Contracts on, choose contract types and options, and set the defaults every new contract starts with.',
    screens: ['^/staff/admin/contracts'], contexts: ['contracts-settings'],
    keywords: 'contracts settings types options notice renewal expiring lock rules customer contracts master agreement contracts plan',
    related: ['contracts'],
    body: `Administration → **Contracts** works in layers, like Sourcing:

1. **Your plan or licence** includes Contracts. The **Contracts plan** has Contracts without supplier onboarding — then the menus show only Contracts, Parties and administration, and Administration shows only what Contracts uses: users, contract roles, Contracts, workspace (branding, country, security, working days, email), sign-in, integrations (email, storage, AI) and the audit log. Supplier settings, the supplier form, ERP integration and onboarding permissions are hidden.
2. **Switch Contracts on** for the workspace. When it is off the menus are hidden; your contracts are kept.
3. **Contract types**: NDA, master agreement, SOW, rate contract, service, purchase, sales, distribution, lease, licence and other. Each has its own number prefix; some are only for suppliers or only for customers.
4. **Options**: customer contracts, linking parties to onboarded suppliers, contracts under a master agreement, Excel import, templates from the clause library, your own Word templates, internal approval, review by the other party, e-signature, obligations and milestones, renewal and notice alerts, **contract watch** (decisions waiting on signed contracts — see Contract watch) with an optional **AI summary** from general facts only (needs the AI feature), order and invoice price checks (needs purchase orders) sending contracts to the ERP (needs ERP integration) and **reading uploaded contracts** (needs the AI feature; names, numbers, amounts and dates are masked before the AI sees the text — without it, VendorGate's own rules read the file and nothing leaves VendorGate). Rules also set the **price tolerance** (how far above the contract price is accepted) and how many days before the notice date the owner is reminded.
5. **Rule defaults**: notice period, renewal term, how many days before the end a contract counts as *expiring*, and whether a value is required. **Lock** a rule so it can't be changed on a contract.

6. **Our company on contracts**: your legal name, registration and tax numbers, address, city (used for courts, the arbitration seat and the place of signing) and signatory — printed in documents. Empty boxes use your billing details.
7. **E-signature** (when the option is on): choose the provider — DocuSign, Adobe Acrobat Sign, Zoho Sign, Aadhaar eSign / DSC through Digio, UAE PASS, or *Test signing* to try the flow (not a legal signature). Enter the credentials from the provider (secrets are stored encrypted and never shown again; leave a secret empty to keep it), keep *Sandbox* ticked until you have tried it, and use **Test the connection**. For DocuSign, Adobe, Zoho and Digio, give the provider the webhook URL shown; VendorGate also checks every 15 minutes.
8. **Contract approval**: levels like the onboarding approval flow. Rules can use the value, type, supplier or customer, category, *wording changed from the library* and *a fallback clause is used*. By default: Legal Counsel when the wording was changed or a fallback is used, Finance above 10 lakh, and senior management above 1 crore. If no level applies, the contract is approved straight away.

People also need permissions (Administration → Roles): *View contracts and contract parties*, *Create and edit contracts and parties* and *Manage contract templates and the clause library*. The **Contract Manager** role has all three; **Legal Counsel** can view contracts and manage templates.`,
  },
  {
    id: 'contract-drafting', title: 'Drafting a contract and approval', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'Draft from a template, choose standard or fallback wording, make the Word and PDF, and send it for internal approval.',
    screens: ['^/staff/contracts/'], contexts: ['contracts'],
    keywords: 'draft template clause fallback wording non-standard word pdf document approval submit legal finance send back withdraw reopen jurisdiction governing law',
    related: ['contracts', 'contract-templates', 'contract-library'],
    body: `On a draft contract, **Draft from a template**: choose the template and the country (India, UAE or Saudi Arabia). Clauses follow the country — governing law, disputes, tax and data protection change with it.

- Open a clause to read it. Choose **Standard**, one of its **fallbacks** (alternatives your legal team pre-approved) or **Edit the wording**. Edited wording makes the contract **non-standard**; a fallback is marked as **fallback used**. Both can bring in Legal approval.
- Optional clauses can be left out; **+ Add a clause** brings in any other clause from the library (non-standard).
- **Save wording**, then **Make the document**: VendorGate fills in the merge fields (party names, value in words, dates, notice period, signatories) and makes a Word file and a PDF, listed under Files. Anything still blank is shown, e.g. a missing tax number.
- Changing the wording or the contract's details marks the document **out of date** — make it again before submitting.
- **Submit for approval** sends it through the levels your administrator set; each approver is emailed. They approve, send back with remarks, or reject. The owner or the person who drafted it can't approve it. **Withdraw from approval** to change it; an approved contract can be **reopened as a draft** (approval starts again).
- Once approved, send the PDF for signature, upload the signed copy and **Mark as signed**.`,
  },
  {
    id: 'contract-templates', title: 'Contract templates', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'Templates built from the clause library, or your own Word documents with merge fields.',
    screens: ['^/staff/contract-templates'], contexts: ['contract-templates'],
    keywords: 'template word docx merge field clauses heading opening paragraph upload nda service supply msa sales',
    related: ['contract-library', 'contract-drafting'],
    body: `Contracts → **Templates**. Built-in templates: mutual NDA, service / maintenance agreement (AMC), supply / rate contract, master services agreement and sales agreement.

**From the clause library**: a heading, an opening paragraph (who the parties are) and clauses in order. Untick *Required* to let drafters leave a clause out. Each template is for some contract types and for suppliers, customers or both.

**Your own Word template**: upload a .docx with merge fields written like \`{{party.legalName}}\`, \`{{contract.value}}\` or \`{{us.signatoryName}}\` — the list of fields is in the *Insert a field* menus. To print the drafted clauses, put \`{{#clauses}}\`, then \`{{number}}. {{title}}\` and \`{{body}}\` on their own lines, then \`{{/clauses}}\`, and choose the clauses below. Unknown fields are refused when you upload. Macro-enabled files aren't accepted.

Changing a template never changes contracts already drafted. Managing templates needs *Manage contract templates and the clause library*.`,
  },
  {
    id: 'contract-library', title: 'Clause library', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'Standard clause wording and pre-approved fallbacks, for India, the UAE and Saudi Arabia.',
    screens: ['^/staff/contract-clauses'], contexts: ['contract-library'],
    keywords: 'clause library wording fallback guidance governing law arbitration gst vat dpdp pdpl stamp duty jurisdiction reset',
    related: ['contract-templates', 'contract-drafting'],
    body: `Contracts → **Clause library** holds the wording templates are built from, by category. The built-in library covers commercial terms (scope, term, price and payment, orders and delivery, service levels), legal terms (warranties, IP, liability, indemnity, termination, force majeure), confidentiality, data protection (DPDP Act 2023 in India, PDPL in the UAE and Saudi Arabia), tax (GST, VAT), governing law and disputes (Indian arbitration, DIAC, SCCA), stamp duty (India) and language (UAE, Saudi Arabia).

- A clause can have up to six **fallbacks** — alternative wording your legal team accepts (for example payment in 45 days, a higher liability cap).
- **Guidance** is shown to drafters, never printed.
- Built-in clauses can be edited; **Reset to standard** puts back the original. Archived clauses aren't offered for new drafts.
- Merge fields are inserted with *Insert a field*; unknown fields are refused.

The built-in wording is a starting point — have your counsel review it before first use.`,
  },
  {
    id: 'contract-signing', title: 'Review by the other party and signature', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'Send a version to the supplier or customer, work through their comments, and send it for e-signature.',
    screens: ['^/staff/contracts/'], contexts: ['contracts'],
    keywords: 'review counterparty supplier customer comment propose wording redline marked up accept changes version signature esign docusign adobe zoho aadhaar dsc digio uae pass sign',
    related: ['contract-drafting', 'contracts-settings'],
    body: `**Review by the other party.** Once the contract is approved (or straight from a draft when approval is off), **Send to … for review**: choose their contacts and add a message. Each person gets an email link and opens the contract with a one-time code; an onboarded supplier also finds it under *Contracts* in their supplier portal. They can download the Word and PDF, comment on any clause, **propose new wording**, upload their marked-up copy, and **accept** the version or **ask for changes**.

- Their comments appear on the contract. **Accept their wording** puts it into the draft (the contract becomes non-standard and goes back to draft — make the document again, get approval again if needed, and send the new version). You can also decline or mark a comment resolved.
- **Reply or note** sends a reply they can see; tick *Internal note* for your team only.
- Each version and their answer is listed; an older version is replaced when you send a new one.

**Signature.** When they accept (or straight after approval), **Send for signature**: check the signers — at least one for them and one for us. They sign first, then us.

- With DocuSign, Adobe Acrobat Sign, Zoho Sign or Aadhaar eSign / DSC (Digio), the provider emails each signer; VendorGate follows the status and fetches the signed PDF.
- With UAE PASS (and Test signing), each signer presses **Sign** in VendorGate when it is their turn and signs with their own UAE PASS account.
- When everyone has signed, the signed PDF is stored as the signed copy and the contract becomes **active**; the owner and the other party are emailed.
- **Cancel the request** stops it at the provider. Paper signatures still work: upload the signed copy and **Mark as signed**.`,
  },
  {
    id: 'contract-obligations', title: 'Managing signed contracts', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'Obligations and reminders, renewal and notice alerts, amendments and ending a contract.',
    screens: ['^/staff/contract-obligations', '^/staff/contracts/'], contexts: ['contract-obligations', 'contracts'],
    keywords: 'obligation milestone deliverable payment report reminder overdue recurring renewal notice alert amendment extend extension change value price list rate price check tolerance invoice purchase order erp blanket agreement',
    related: ['contracts', 'contract-drafting', 'contract-signing'],
    body: `**Obligations.** On a contract, **+ Add obligation**: what has to be done, by whom (us or them), the due date, whether it repeats (monthly, quarterly, yearly), an owner and how many days before to remind. The owner is emailed before the due date and again if it becomes overdue. **Done** on a repeating one adds the next. Contracts → **Obligations** lists them across all contracts — overdue, due in 30 days, only mine.

**Renewal and notice alerts.** The contract's owner is emailed once when it enters the *expiring* window, and once before the last day to give notice (end date minus the notice period) — so an automatic renewal is never a surprise.

**Amendments.** Dates, value, renewal or notice of a signed contract change through an amendment: **+ New amendment**, say what changes, and it is created as a draft under the contract (AMD-2026-0001). Draft it from the *Amendment agreement* template (the changes print as (a), (b), (c)…), get it approved, reviewed and signed like any contract. When it is signed the changes apply to the contract, and both show the history.

**Agreed prices.** Add the contract's prices (or import them from Excel), matched on the ERP item code. Purchase orders and supplier invoices from that supplier show **Contract prices**: each line's price against the contract price, flagged when it is above the price plus your tolerance.

**ERP.** When a supplier contract (with an onboarded supplier) is signed, it goes to the ERP as a blanket agreement with its prices, through your ERP connection; the contract shows whether it was sent, and **Send again** retries.`,
  },
  {
    id: 'contract-reading', title: 'Reading an uploaded contract', audience: ['staff'], perms: ['contracts.manage'], feature: 'contracts',
    summary: 'Upload the other party’s contract (Word or PDF) and let VendorGate find the dates, value, notice and renewal terms for you.',
    screens: ['^/staff/contracts/'], contexts: ['contracts'],
    keywords: 'read extract ai upload their paper third party pdf word dates value notice renewal governing law suggestions mask privacy what the ai saw scan',
    related: ['contracts', 'contracts-settings', 'contract-obligations'],
    body: `When a contract is on the other party's paper, upload it (Word .docx or a PDF with text) to the contract and click **Read** next to the file in **Read the contract**.

VendorGate suggests the **start, end and signing dates**, the **value**, the **notice period**, whether it **renews automatically** and for how long, the **contract type** and the **governing law** — each with the sentence it was found in. Tick the ones that are right and **Use the ticked values**; nothing changes until you do. On an active contract only the terms you could edit anyway can be used; dates and value change through an amendment.

**Privacy.** With the *Read uploaded contracts* option on, the text goes to the AI only after VendorGate replaces every party name, tax and registration number, email, phone, account number, amount and date with a placeholder such as [PARTY-1] or [DATE-2]. The AI only says which placeholder is which term; VendorGate puts the real values back here. If anything from the record would still be sent, nothing is sent. **What the AI saw** shows exactly what left VendorGate. Without the option, VendorGate's own rules read the file and nothing is sent anywhere.

A scanned PDF has no text to read — upload the Word file or a text PDF instead. The AI may also add short notes (for example a notice period that is unusually short).`,
  },
  {
    id: 'contract-reports', title: 'Contract reports', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'What is under contract, what ends soon, obligations kept on time, time to sign and order prices against contract prices.',
    screens: ['^/staff/contract-reports'], contexts: ['contract-reports'],
    keywords: 'report reports dashboard value under contract spend by type top suppliers customers pipeline expiring renewal obligations on time cycle time to sign price leakage excel download',
    related: ['contracts', 'contract-obligations'],
    body: `Contracts → **Reports** shows:

- **Under contract**: the value of active supplier and customer contracts, by type and by the largest parties.
- **Pipeline**: how many contracts are at each stage, from draft to signed.
- **Ending in the next 90 days**, and whether each renews automatically.
- **Obligations**: overdue, and the share done on time in the last 90 days.
- **Time to sign**: average and median days from creating a contract in VendorGate to signing, by type (last 12 months).
- **Order prices against contract prices** (with price checks on): purchase order lines of the last 90 days that were above the agreed price, and how much was paid over it.

Figures refresh every minute. **Download Excel** gives the same figures as a workbook.`,
  },
  {
    id: 'contract-watch', title: 'Contract watch', audience: ['staff'], perms: ['contracts.view'], feature: 'contracts',
    summary: 'Contracts that need a decision — renewals and notice dates, the other party’s late obligations, missing owners — with a decision pack and drafts.',
    screens: ['^/staff/contract-watch', '^/staff/contracts/'], contexts: ['contract-watch', 'contracts'],
    keywords: 'watch agent decision renew renegotiate end notice auto renewal spend value price above leakage overdue late obligation supplier hold risk owner unused idle snooze dismiss digest weekly email',
    related: ['contract-obligations', 'contract-reports', 'contracts-settings'],
    body: `Every night VendorGate looks at your active contracts and lists the ones that need a decision. It also looks again when purchase orders arrive.

- **Renew, renegotiate or end**: the last day to give notice is inside your decision window (90 days by default). Urgent near the notice date, or when it has passed.
- **Prices above the contract**: order lines in the last 90 days above the agreed price (after your tolerance), and the excess paid.
- **Spend against the contract value**: orders have reached your warning share of the value (80% by default), and again at 100%.
- **The other party is late**: their obligations are overdue (urgent after 30 days).
- **Supplier on hold or high risk**: worth a look before renewing.
- **No owner**: nobody would get its reminders.
- **Not used**: an active supplier contract with no orders for some months.

Each one says why. Click what you did (for example **Renew or extend** — then start the amendment on the contract — or **Taken up with the supplier**), **Dismiss** it with a reason, or **Snooze** it until a date. Decisions show in the contract's history; anything decided isn't raised again for the same date or period, and anything whose reason has gone disappears by itself.

Contracts → **Watch** lists everything (only mine, by kind, snoozed, decided); each contract shows its own in **For your review**. Owners are emailed straight away about urgent ones and get a weekly digest. Nothing is sent to the other party. Administration → Contracts switches watch on or off and sets the decision window, spend warning, "unused after" and digest day.

**Decision pack.** Click **Decision pack** on any item for what you need to decide: the term and notice date, orders against the value, prices above the contract and the excess, obligations kept on time, the supplier's risk, hold and scorecard, amendments and earlier decisions — with VendorGate's recommendation (**Renew**, **Renegotiate** or **Let it end**) and the reasons. A short summary is written by VendorGate's rules or, with *AI summary in contract watch* on, by the AI from general facts only (ranges, counts, yes/no, with the contract and party as [CONTRACT] and [PARTY]) — **What the AI saw** shows exactly what was sent.

**Drafts.** Where it helps, the pack offers a draft to the other party — chase overdue obligations, query prices above the contract, ask to renegotiate, or give notice of non-renewal — with the real names, dates and lines filled in. VendorGate doesn't send it: edit it, then **Copy** it or **Open in my email** and send it yourself. Check the contract's notice clause for how notice must be given.

Contracts → **Reports** shows what watch achieved over 12 months: decisions made, renewal decisions made before the notice date, contracts let end, and price excess taken up with suppliers.`,
  },
  {
    id: 'contract-migration', title: 'Bringing existing contracts in', audience: ['staff'], perms: ['contracts.manage'], feature: 'contracts',
    summary: 'Parties, contracts and obligations from Excel, signed copies in bulk, the terms read from the files, and a checklist of what is still missing.',
    screens: ['^/staff/contract-migration'], contexts: ['contract-migration'],
    keywords: 'migration migrate import existing legacy contracts excel bulk upload zip signed copies scans inbox match file name contract number reference read files master agreement statement of work obligations checklist missing',
    related: ['contracts', 'contract-parties', 'contract-reading', 'contract-obligations'],
    body: `Contracts → **Bring contracts in** walks through moving a company's existing contracts into VendorGate (a Contracts-only workspace needs no supplier onboarding — suppliers and customers are parties).

1. **Parties and contracts from Excel.** Import parties, then contracts (or tick *Create missing parties*). A statement of work can name its **Master agreement** — the master agreement's contract number, or its reference if it is on an earlier row of the same sheet.
2. **Signed copies in bulk.** Choose up to 25 files or .zip files at a time (Word, PDF or images). Each file goes to the contract whose **number** (SVC-2026-0001) or **reference** is in its name. **Check** shows where each will go; nothing is saved until you **Upload**. Files already on the contract are skipped; a .zip may hold up to 500 files.
3. **Inbox.** Files that matched no contract — or several — wait here. Attach each to its contract, or make a **New contract** from it: it starts as a draft with the file as its signed copy, and VendorGate reads the terms; check them, then mark it as signed.
4. **Read the uploaded contracts.** Reads every Word or PDF contract that hasn't been read, the same way as *Read the contract* (names, numbers and amounts masked before any AI). Scans can't be read.
5. **Review the values found.** What reading found that the contract doesn't have yet. **Use these** fills them in. On an active contract only empty details (end date, value) and the renewal terms can be filled in this way — once set, dates and value change through an amendment.
6. **Obligations from Excel**, for many contracts at once (each row names its contract by number or reference).
7. **What is still missing**: active contracts with no signed copy, no owner, no end date or no notice period, and drafts waiting to be marked as signed — each opens the contract.`,
  },
  {
    id: 'ap-invoices', title: 'Invoices (accounts payable)', audience: ['staff'], perms: ['invoices.view'], feature: 'invoices',
    summary: 'Enter, check and approve supplier invoices against a purchase order, a contract or neither, and send them to the ERP.',
    screens: ['^/staff/ap/invoices', '^/staff/ap/ready', '^/staff/ap/payments'], contexts: ['ap-invoices'],
    keywords: 'invoice accounts payable ap non-po credit note debit note approval matrix touchless push erp oracle payables ready bulk upload excel coding gl account cost centre',
    related: ['invoices-settings', 'ap-codes', 'ap-reports'],
    body: `**Invoices** is an add-on: every supplier invoice in one list, whatever it is against.

- **Purchase order invoices** are matched to the order lines, receipts and earlier invoices (the same checks as invoices suppliers submit in the portal, which also appear here).
- **Contract invoices** are checked against the contract's agreed prices, value and term.
- **Invoices without a PO or contract** (rent, utilities, services): each line is coded to a **GL account** and **cost centre** (and project, if used) from the code lists. Empty lines take the supplier's default coding.

**Entering an invoice**: **+ New invoice** → supplier, what it is against, number, date, total and lines → **Save draft**. VendorGate checks it straight away (totals, coding, duplicates, supplier on hold, India e-invoice and GST type). Attach the supplier's PDF, then **Save and submit**. You can also **Upload PDFs** (a PO number in the file name links the order; the same file twice is skipped) or **Import from Excel** — both make drafts to finish.

**Approval**: a submitted invoice goes through the **approval matrix** — for example the cost-centre owner for invoices without a PO, AP review for exceptions, finance above an amount. The person who entered an invoice can't approve it. When no level applies, a **clean** invoice can be approved **touchless** (if switched on); otherwise someone with invoice management approves it.

**To the ERP**: approved invoices are sent to Oracle Payables automatically, or wait in **Ready for ERP** until you choose them and press **Send** — your administrator decides. If Payables rejects one it shows under **Import failed** with the reason; holds placed in Oracle show on the invoice. Payments reported by the ERP settle the invoice.

**Credit and debit notes**: a **credit note** from the supplier reduces an invoice; a **debit note** is raised by you (numbered DN-…, with a PDF) for short supply, price differences or rejected goods, and can be emailed to the supplier's accounts address. Both reduce the net payable.`,
  },
  {
    id: 'ap-codes', title: 'Invoice code lists', audience: ['staff'], perms: ['tenant.settings'], feature: 'invoices',
    summary: 'The operating units, GL accounts, cost centres, projects and tax codes AP codes invoices to — refreshed from the ERP.',
    screens: ['^/staff/admin/invoice-codes'], contexts: ['ap-codes'],
    keywords: 'code lists gl account cost centre owner project task operating unit tax code combination refresh oracle excel',
    related: ['ap-invoices', 'invoices-settings'],
    body: `Code lists come from the ERP: with Oracle E-Business Suite they are **refreshed every night** (and with **Refresh from the ERP**) from the code lists URL under ERP integration; other ERPs send them through the API; or **import them from Excel**. A code the ERP no longer sends is closed, and closed codes can't be used on new invoices.

What you keep in VendorGate:
- **AP may use it** — untick codes AP shouldn't pick.
- **Owner** of each cost centre — the budget owner the approval matrix sends invoices to. A cost centre without an owner goes to everyone with the level's role.
- Codes the ERP doesn't send can be **added here**.`,
  },
  {
    id: 'ap-reports', title: 'Invoice reports', audience: ['staff'], perms: ['invoices.view'], feature: 'invoices',
    summary: 'Ageing of unpaid invoices, what is owed per supplier, cycle time, the touchless rate, exceptions and spend.',
    screens: ['^/staff/ap/reports'], contexts: ['ap-reports'],
    keywords: 'invoice reports ageing overdue owed cycle time touchless exceptions spend gl account cost centre excel',
    related: ['ap-invoices'],
    body: `- **Ageing**: approved invoices not yet paid (less credit and debit notes), by how long past the due date.
- **Owed to suppliers**: the largest open amounts, with what is overdue.
- **Cycle time**: from entry to approval, and from approval to payment (12 months).
- **Touchless**: the share of approved invoices that needed no one.
- **Exceptions**: which checks failed most in 90 days and how those invoices ended.
- **Spend** by supplier, GL account, cost centre and basis.

**Download Excel** gives the same figures. They refresh every minute.`,
  },
  {
    id: 'invoices-settings', title: 'Invoices settings', audience: ['staff'], perms: ['tenant.settings'], feature: 'invoices',
    summary: 'Switch Invoices on, choose bases and options, touchless and ERP push rules, the approval matrix and the Oracle account format.',
    screens: ['^/staff/admin/invoices'], contexts: ['invoices-settings'],
    keywords: 'invoices settings add-on touchless push automatic manual approval matrix cost centre owner debit note email account format oracle api key',
    related: ['ap-invoices', 'ap-codes'],
    body: `Administration → **Invoices**:

1. **Your plan or licence** includes the Invoices add-on (any plan). Switch it on for the workspace; invoices from the supplier portal then join the AP list.
2. **What invoices are against**: purchase orders, contracts, neither.
3. **Options**: bulk PDF upload, Excel import, touchless approval, credit notes, debit notes.
4. **Rules**: price tolerance; whether a cost centre is required; which invoices may go through **touchless** and up to what amount; **push to the ERP** automatic or manual; whether debit notes are **emailed** to suppliers always, when AP chooses, or never; default days to pay.
5. **Approval matrix**: levels top to bottom, each with a rule. A level can go to the **owner of the invoice's cost centre** (set on Code lists). The default: budget owner for invoices without a PO, AP review for exceptions, finance above 10 lakh, director above 1 crore.
6. **Account in Oracle**: how a line's coding joins into the account combination, e.g. *{entity}.{costCentre}.{account}.000*.
7. **API keys** for the ERP or middleware: code lists, import results and payments.`,
  },
];

export const articleById = (id: string) => ARTICLES.find((a) => a.id === id);
