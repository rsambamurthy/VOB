# VendorGate — working rules

## Reuse, never duplicate (standing rule from the product owner)

Anything built must be reusable. When the same behaviour is needed in two places, build it once and use it in both —
never copy it. Copies drift apart and end up as version mismatches (example: "Fill in for supplier" missed
documents-first because the supplier portal had its own copy of that logic).

- Before writing a helper, component or rule, search for an existing one and extend it instead.
- If code is about to be copied, move it into a shared module first, then use it from both places.
- Shared lists and rules (statuses, field rules, document rules) live in one module and are imported, not re-typed.

### Where the shared pieces live

**Onboarding form** (supplier portal *and* a buyer filling in for the supplier):
- Server rules: `server/src/services/onboarding.ts`
  - `saveSection`, `addDocument`, `applyExtractedValues`, `submitForReview`
  - `docRequirementsFor`, `formState`, `checkExpiry`
- Routes `routes/vendorPortal.ts` and `routes/assist.ts` only handle permissions and response shape.
- Statuses: `server/src/lib/onboardingStatus.ts` (`EDITABLE_STATUSES`, `isEditableStatus`, `activeTypes`).
  - On the web side: `isEditableStatus` in `web/src/lib/types.ts`.
- File uploads: `server/src/lib/upload.ts`.
- Documents-first on the web: `web/src/lib/documentsFirst.ts`
  - `formTabs`, `useRefreshWhileReading`, `fieldSources`, `docLabelFor`
- Read-values cards: `ExtractionList` / `ExtractionCard`.
- Form rendering: `DynamicSection`, `DocumentsPanel`, `Checklist`.

**Agreements** (code of conduct, NDA):
- Rules: `server/src/services/agreements.ts`.
- Checklist and submit go through `services/onboarding.ts` (`formState`).
- Screens: one `AgreementsPanel` (`web/src/components/Agreements.tsx`) for the portal, the buyer's fill-in and reviewers.

**Questionnaires** (ESG, information security…):
- Rules: `server/src/services/questionnaires.ts`.
- Answering routes come from one `answerRoutes()` (`routes/questionnaires.ts`), mounted in both the portal and the buyer's fill-in.
- Screens: one `QuestionnairesPanel` (`web/src/components/Questionnaires.tsx`).
- Conditions reuse `RulePicker` / `ConditionEditor` from `pages/admin/config/shared.tsx`.

**Risk** (scores, monitoring, bank-change risk):
- Rules: `server/src/services/risk.ts`.
- Checks marked `monitor: 'critical'` in the country packs are re-checked by monitoring.
- Automatic holds go through `applySystemHold` (lifecycle), shared with document-expiry holds.
- Badges and signals: `web/src/components/Risk.tsx`.

**Pre-review for approvers**:
- Findings: `server/src/services/preReview.ts`, built from `formState`, checks, extractions, duplicates and risk.
- AI part: `integrations/ai/preReviewer.ts` (mock and Claude, like the help answerer).
- **Privacy mode is the only way the AI is used:** `gather()` builds a payload of general facts only (fixed-list choices, ranges, check results, bands) with names as `[SUPPLIER]` / `[OTHER-n]`, every finding has a safe `aiText`, and `leaks()` refuses to send if any value from the record appears. Names are put back locally; the payload is stored in `pre_reviews.sent_to_ai` (“What the AI saw”). Never add names, numbers, addresses, emails or free text to that payload.
- Facts worked out locally for the AI: `server/src/services/aiFacts.ts` — yes/no `comparisons` (general + each country pack's `consistencyFacts`, e.g. India's GSTIN state / PIN code / PAN type in `countries/in/consistency.ts`), `comparisonConcerns` (the ones that become findings), `peerComparison` (percentiles among approved suppliers, 5+ only) and amounts by `aiPrecision` (ranges or exact). Add new market comparisons here, not in the AI prompt.

**Supplier guide** (AI-guided onboarding — portal *and* the buyer's fill-in):
- What an approver would pick up: `server/src/services/submissionIssues.ts` — shared by the pre-review and the guide (staff, supplier and AI wording for each issue).
- Guide rules: `server/src/services/guide.ts` (next step, check before submit, send-back to-do, ask); routes from one `guideRoutes()` (`routes/guide.ts`), mounted in both the portal and assist.
- AI: send-back to-do in `integrations/ai/guideWriter.ts` (AI or rules); questions reuse the help answerer (`answerHelpQuestion` in `routes/help.ts`).
- Privacy helpers for every AI use: `server/src/services/aiPrivacy.ts` (`identifiersOf`, `leaks`, `pseudonymise`, `reidentify`, `optionValues`).
- Screens: `GuidePanel` and `SubmitCheck` (`web/src/components/Guide.tsx`); help article picking is shared with F1 (`articlesForQuestion`).

**Corrective actions** (suggested from findings, conditions of approval, evidence, reminders):
- Rules: `server/src/services/correctiveActions.ts` (`suggestActions`, `raiseActions`, `submitResponse`, `reviewAction`, `runActionReminders` — job `actions.daily`).
- Routes: `routes/correctiveActions.ts` — staff `actionsRouter` and the supplier's `supplierActionRoutes()` (portal).
- Overdue actions feed the risk score (`signalsFor`) and holds go through `applySystemHold`; open actions are the guide's next step and a pre-review finding.
- Screens: one `ActionsPanel` for supplier and staff, `StaffActions` / `RaiseActionsModal` (`web/src/components/CorrectiveActions.tsx`); overview page `pages/CorrectiveActions.tsx`.

**On-premises** (`DEPLOYMENT_MODE=onprem`):
- Licence rules (pure, signed Ed25519 tokens, states valid → expiring → grace → read-only): `server/src/lib/licence.ts`; public keys `lib/licenceKeys.ts`; storing/loading/reminders `services/licence.ts` (job `licence.daily`); Administration → Licence (`routes/licence.ts`, `pages/admin/Licence.tsx`).
- Read-only for staff via `licenceGuard` (auth/session.ts); limits and features from the licence in `plans.effectiveLimits`. Platform console, sign-up and billing are off on-prem (app.ts).
- Administration commands built into the image: `server/src/cli.ts` (`node server/dist/cli.js …`). Licence issuing tool for Integratatech: `server/scripts/licence.ts`.
- Kit: `onprem/` (docker-compose.yml, .env.template, nginx with a supplier-only port, scripts, docs, build-kit.sh). Never add an outbound call that is required — every external service must be optional.

**Creating suppliers**: `server/src/services/vendors.ts` (`createVendor` with `prefill` / `approved`).
- Used for invites, Excel invites, approved imports and accepted applications.

**Self-registration** ("Become a supplier" links):
- Rules: `server/src/services/applications.ts`.
- Public pages share `SupplierPublicCard` with the invitation sign-in.

**Duplicate check:** `server/src/services/duplicates.ts`.
- Every profile write uses `withIdentity(profile)`.

**Form and document rules:** `server/src/lib/profileEngine.ts`.

## Other conventions

- Every change ships with tests:
  - server: `cd server && npx vitest run`
  - browser: `npx playwright test`
- User-facing text is plain English. Supplier-facing text also needs Arabic (`npm run i18n:check`).
- Schema changes:
  1. Edit `server/src/db/schema.ts`.
  2. Run `npx drizzle-kit generate --name <what>`.
  3. Migrations run on deploy.
