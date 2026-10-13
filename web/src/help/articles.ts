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
  feature?: 'erp' | 'ai' | 'kyc' | 'collab';
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
- **Privacy & data retention**: the privacy notice suppliers accept and how long old registrations are kept. See [Privacy and data protection](#privacy).

Changes apply as soon as you click **Save**.`,
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
    keywords: 'role roles permission permissions access rights administrator vendor admin tax finance master data mdm viewer who can',
    related: ['users', 'config-workflow'],
    body: `A role is a bundle of permissions. Every workspace starts with these roles; edit them or click **New role** to make your own.

![The Roles page](/help/04-roles.jpg)

- **Administrator**: everything.
- **Vendor Admin**: view and invite vendors, see reports.
- **Tax Accounts Manager**: view vendors; handles the tax review level.
- **Finance Manager**: view vendors and reports; handles the finance and risk level.
- **Master Data Manager**: final approval, ERP export, block vendors, propose changes.
- **Viewer**: read-only.

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

## Publish
1. Edit anything; the bar at the top shows you have an unpublished draft.
2. Click **Preview form** to see it as a supplier will.
3. Click **Publish…**, add an optional note, and confirm.

Suppliers part-way through see the new version next time they open their portal; the answers they saved are kept. Click **Discard draft** to throw your changes away.`,
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
    id: 'integrations', title: 'Email, SMS and other integrations', audience: ['staff'], perms: ['tenant.settings'],
    summary: 'Test email delivery, choose how suppliers get sign-in codes, turn AI reading on or off.',
    screens: ['^/staff/admin/integrations'],
    keywords: 'integration integrations email mail smtp resend sendgrid sms otp code delivery storage ai document reading test email junk spam',
    related: ['troubleshooting', 'supplier-signin'],
    body: `Administration → **Integrations** shows each connected service and lets you test it.

- **Email**: click **Send me a test email**. The card shows how many emails were sent or failed.
- **Send vendor sign-in codes by**: Email only, or Email and SMS, or SMS (email if SMS fails).
- **AI document reading**: tick **Use AI to read uploaded documents** to let VendorGate suggest form values from what suppliers upload. Suppliers always review suggestions before they're used.
- **Storage** and **verification**: shows where documents are stored and whether online checks are live.

> If emails land in Junk, ask recipients to mark them **Not junk** and add the sender to their contacts.`,
  },

  /* ---------------- Vendors ---------------- */
  {
    id: 'invite-vendor', title: 'Inviting a vendor', audience: ['staff'], perms: ['vendors.create'],
    summary: 'Create a vendor and email them a secure registration link.',
    screens: ['^/staff/vendors/?$'],
    keywords: 'new vendor add vendor create supplier invite invitation register onboard resend link email contact',
    related: ['vendor-list', 'vendor-statuses', 'supplier-signin'],
    body: `1. Go to **Vendors** and click **+ New vendor**.
2. Enter the vendor name, type (Domestic, Import or Government) and the contact's name, email and mobile.
3. Leave **Email the invite link to the contact now** ticked and click **Create & notify contact**.

@video(/help/a-invite.mp4 | Inviting a vendor)

The vendor appears as **Invited** with a code such as VND-00012. If the email didn't arrive, open the vendor and click **Resend invite** (possible until they submit). VendorGate warns you if a vendor with the same name already exists.`,
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
    summary: 'Send approved vendors to Oracle EBS, a webhook or CSV files.',
    screens: ['^/staff/admin/erp'],
    keywords: 'erp oracle ebs e-business suite webhook csv sftp export push sync integration test mode payload deliveries retry',
    related: ['block-recheck', 'reports'],
    body: `Administration → **ERP integration** sends approved vendors (and later changes, blocks and unblocks) to your ERP.

![ERP integration](/help/17-erp.jpg)

## Connectors
- **Oracle E-Business Suite**: creates and updates suppliers; needs the endpoint, credentials and operating unit (ORG_ID).
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
    body: `- **Privacy notice**: under Workspace → *Privacy & data retention (DPDP)*. Suppliers accept it before filling the form; editing it creates a new version they accept again. Add your **Grievance officer email** here.
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
- If AI document reading is on, click **Review suggested values →** after uploading, and pick which values to copy into the form.`,
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
Each acceptance is sent to the ERP and listed under **Messages to the ERP**. **Payload** shows exactly what was sent. If sending failed, fix the cause (often the Acknowledgement URL or the ERP being down) and click **Retry**. "No ERP connection" means nothing is set up to receive acceptances — ERPs can still read them from \`/api/v1/acknowledgements\`.`,
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
  /* ---------------- Country rules (Saudi Arabia and the Gulf) ---------------- */
  {
    id: 'expiry-hold', title: 'Automatic hold when a document lapses', audience: ['staff'], perms: ['vendors.view', 'config.manage'],
    summary: 'Vendors go on hold when a key certificate or licence expires, and come off hold when the renewal is approved.',
    keywords: 'hold block expired lapsed zakat gosi nitaqat saudization cr confirmation certificate trade licence license renewal payment hold automatic uae bahrain',
    related: ['document-expiry', 'sanctions-screening'],
    body: `Some documents must stay valid for a supplier to keep being paid — in Saudi workspaces the CR (annual confirmation), Zakat, GOSI and Saudization (Nitaqat) certificates; in the UAE the trade licence; in Bahrain the CR.

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
    summary: 'Gulf workspaces screen every supplier’s legal name against sanctions lists on submission and at each re-check.',
    keywords: 'sanctions screening ofac un eu uk list match aml compliance possible match clear',
    related: ['expiry-hold'],
    body: `In Saudi (and other Gulf) workspaces every supplier is screened against sanctions lists:

- automatically when they submit for review,
- again at every periodic re-check,
- and on demand with **Run** in the vendor’s **Verifications** card.

**Clear** means no match. **Possible match** means a reviewer must look at the details before approving — most possible matches turn out to be similar names. Record your conclusion in the approval remarks.

> Until a live screening provider is connected, results come from a test list.`,
  },
  {
    id: 'working-days', title: 'Deadlines in working days', audience: ['staff'], perms: ['tenant.settings', 'orders.manage'],
    summary: 'Approval deadlines and purchase-order auto-accept can skip the weekend.',
    contexts: ['purchasing-groups'],
    keywords: 'weekend working days friday saturday sunday deadline sla auto accept calendar business days',
    related: ['purchasing-groups'],
    body: `With **Count deadlines in working days** on (Admin → Workspace → Vendor lifecycle), the hours allowed for each approval level and the days before a purchase order auto-accepts don’t count the weekend.

- Saudi Arabia and Bahrain: Friday and Saturday. UAE: Saturday and Sunday. It is on from the start in Gulf workspaces.
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
];

export const articleById = (id: string) => ARTICLES.find((a) => a.id === id);
