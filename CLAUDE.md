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

**Plan / licence features** (cloud plans, workspace overrides and on-prem licences):
- One list: `server/src/lib/features.ts` (`FEATURES`, `resolveFeatures`, `SOURCING_FORMATS`). `addOn` features (Sourcing) are off unless switched on explicitly.
- Used by `plans.effectiveLimits`, `licence.licenceLimits`, the platform console (`/api/platform/plans`), the licence tool and Administration → Licence. Never re-type feature names or plan defaults on the web side.
- Permissions tied to a feature are hidden on the Roles screen without it (`PERMISSION_FEATURE` / `visiblePermissions` in `lib/permissions.ts`).

**Sourcing** (RFQs and e-auctions):
- Configuration — the only place that decides what is on: `server/src/services/sourcing/config.ts`. Layers: plan/licence (`sourcing` add-on + `sourcingFormats`) → workspace switch → formats → sub-features (`SUB_FEATURES`, some `requires` a plan feature) → rule defaults and locks (`RULES`) → per event (`resolveRules`). Use `sourcingOn` / `formatOn` / `featureOn` / `resolveRules` / `assertSourcingOn`; never read `settings.sourcing` by hand.
- New formats and options are added to the catalogue with `available: false` and flipped when released.
- Events store a snapshot of their rules and options when published; settings changes never alter a published event.
- Tables: `sourcing_events`, `sourcing_lots`, `sourcing_lines`, `sourcing_bidders` (always a VendorGate supplier), `sourcing_submissions` (sealed, encrypted), `sourcing_bids` (append-only, hash-chained), `sourcing_awards`.
- Events: `services/sourcing/events.ts` — numbering per format and year (`NUMBER_PREFIX`), drafts, lots/lines (`saveItems`, Excel `itemsTemplate` / `readItems`), templates (`copyEvent`), checks (`eventIssues`), `submitEvent` / `withdrawEvent` / `cancelEvent`. Event terms are Agreements with `purpose = 'sourcing'` (never asked during onboarding).
- Bidders: `services/sourcing/bidders.ts` — `suggestBidders` (approved, category, risk, scorecard), `addBidders`, `addOutsideBidder` (a supplier with `vendors.bidder_only`, created by `createVendor`; short `registerBidder` reuses `registrationIdFor`/`prefillOf` from applications), `sendInvitations` (event → PUBLISHED), `respond` (terms + conflict declaration), clarifications (`askQuestion`, `publishAnswer` — shared with all bidders, asker hidden). Bidders see only `eventForBidder` (no estimate, targets or other bidders).
- Sealed bids: `services/sourcing/submissions.ts` — `envelopesOf` / `nextEnvelope`, `submitOffer` (content in `sealedJson`, SHA-256 receipt, versions), `confirmOpening` (committee quorum `rules.openingQuorum`, permission `sourcing.open`), technical scoring (`saveScores`, `finishTechnical` with event `scoring` criteria/pass mark), `openedOffers` comparison, `startFromSealed` (reverse auction start prices). Bid files are documents `SOURCING_BID`; `assertBidFileReadable` (documents route) keeps them sealed until opened. Never return submission content before its `openedAt`.
- Live reverse auction: `services/sourcing/live.ts` — `placeBid` (event row locked per bid; own-last-bid step, start price ceiling, earlier bid wins ties, `CONFIRM_BID` for large drops, auto-extension to now + N minutes), append-only hash-chained `sourcing_bids` (`verifyChain`, `bidLogCsv`), `phaseOf` / `syncLive` (status follows the server clock; job `sourcing.live` every minute also sends start reminders), controls (`pauseAuction` / `resumeAuction` / `extendAuction`, strike-out = `requestStrike` + `confirmStrike` by a different person), views `buyerLive` / `bidderLive` (bidders see only their rank, plus best price / ladder by `rules.visibility`; never names). Messages to bidders reuse `publishAnswer` (announcement).
- Live updates: `lib/liveHub.ts` (`publishLive` / `subscribeLive`, server-sent events + Postgres NOTIFY; the message only says "changed"); web hooks `useLive` / `useCountdown` in `web/src/lib/live.ts`. Screens: `LiveMonitor` (`pages/sourcing/EventLive.tsx`) and `LivePanel` in `BidderEvents.tsx`.
- Supplier portal: `routes/supplierSourcing.ts` (`supplierSourcingRoutes`, mounted in vendorPortal); screens `pages/sourcing/BidderEvents.tsx`; bidder-only suppliers see only Sourcing events in `SupplierFrame`. Buyer screens: `pages/sourcing/EventBidders.tsx`, `pages/sourcing/EventSealed.tsx` (scoring sheet, sealed offers, opening, technical evaluation, comparison); the bidder's offer form is `OfferPanel` in `BidderEvents.tsx`. New-vendor and outside-bidder forms share `SupplierContactModal`.
- Award: `services/sourcing/awards.ts` — `resultsFor` (each lot's candidates, best first: live bids, else opened sealed prices), `proposeAward` (winner or split by share, must total 100; `reason` when not all to rank 1 and `awardReason` is on; event → AWARD_PENDING), its own approval flow (subject `sourcing_award`; levels `approvalLevels(t, 'award')`, rule fields `award.value` / `award.notBest` / format / category; the proposer can't approve), `finalizeAward` (→ AWARDED; letters `sourcingAwardWin` / `sourcingAwardWinNew` / `sourcingAwardRegret`; bidder-only winners lose `bidderOnly` and start full onboarding; approved winners get an ERP award message), `releaseAwardsFor` (called by workflowEngine when a supplier is approved), `awardView` (buyer) and `bidderResult` (bidder's own result only). Screen: `AwardCard` (`pages/sourcing/EventAward.tsx`).
- ERP award messages reuse the order outbound pipeline: `queueAwardMessage` (→ `queueStandaloneMessage`) in `services/orders/outbound.ts` (kind `AWARD`, webhook event `sourcing.award.approved`, Oracle `awardUrl`), `po_messages` rows with `eventId` / `vendorId` and no `poId`.
- Tests: shared event setup in `server/tests/sourcingHelpers.ts` (`eventWithBidders`, `closeBidding`, `lastMail`, `inHours`).
- Routes: `routes/sourcing.ts` — `sourcingAdminRouter` (Administration → Sourcing, incl. `/approval` and `/approval?kind=award`) and `sourcingRouter` (404 unless on). Screens: `pages/admin/Sourcing.tsx`, `pages/sourcing/` (Events, EventDetail); shared bits in `components/Sourcing.tsx` (`RuleInput`, `EventStatus`, labels).

**Approval flows other than suppliers** (sourcing events and awards):
- One generic engine: `server/src/services/approvalFlow.ts` (`startFlow`, `decideFlow`, `flowView`, `cancelFlow`, `waitingFor`, `sweepOverdueFlows` in the `sla.sweep` job), table `flow_steps` (subject type + id). Each subject registers a handler (`registerFlowSubject`: describe, approved, returned, blockedFor).
- Levels are `WorkflowLevel`s like the onboarding flow; who may act reuses `approvers.ts`; rules reuse `lib/conditions.ts`.
- Screens: levels editor and tester `LevelsEditor` / `FlowTester` (`pages/admin/config/LevelsEditor.tsx`) — used by the onboarding Approval flow tab, and through `ApprovalLevelsCard` (`components/ApprovalLevelsCard.tsx`) by Administration → Sourcing (event and award flows) and Contracts. Server side: `approvalSetupFor` / `saveFlowLevels` (`routes/approvalAdmin.ts`). Decisions: `FlowPanel` (`components/ApprovalFlow.tsx`), which reuses `ApprovalTimeline`.
- Excel helpers for every import: `lib/excel.ts` (`cellValue`, `colName`); uploads: `excelUpload` in `lib/upload.ts`.

**Module configuration** (shared by Sourcing and Contracts — any new module uses it too):
- `server/src/lib/moduleConfig.ts`: `defineModule({ name, feature, settingsKey, kindsKey, kinds, options, areas, rules, licensedKinds?, keep? })` gives the layers plan/licence feature → workspace switch → kinds → options (`requires` another plan feature; `available: false` = coming later) → rule defaults and locks → `resolveRules`. Also `levelSchema` / `checkLevels` for approval levels.
- The kinds are sent and saved under the module's own key (`formats` for Sourcing, `types` for Contracts).
- Screen: one `ModuleSettings` (`web/src/components/ModuleSettings.tsx`) for every module's Administration page; module-specific cards go in `children`.

**Modules and plans**:
- `onboarding` is a feature (default on) and `contracts` an add-on in `lib/features.ts`; `requires` makes collab and sourcing need onboarding. Plan `contracts` = Contracts without onboarding.
- `moduleGuard` (`lib/modules.ts`) answers 404 `NO_ONBOARDING` for onboarding APIs when onboarding is off; the web hides those menus (`StaffShell`) and `/staff` opens the first screen for the plan (`StaffHome`).

**Contracts** (supplier and customer contracts):
- Configuration: `server/src/services/contracts/config.ts` (`CONTRACT_TYPES` with number prefix and directions BUY/SELL, `OPTIONS`, `RULES`) — use `contractsOn` / `typeOn` / `optionOn` / `contractRules` / `assertContractsOn`; never read `settings.contracts` by hand.
- Parties: `services/contracts/parties.ts` — light records (SUP-/CUS- codes), look-alike check, link to an onboarded supplier (`linkVendor`) or `onboardParty` (uses `createVendor`), Excel import.
- Contracts: `services/contracts/contracts.ts` — one `check()` for create, edit and import (type, direction, party kind, dates, locked rules, owner, master agreement); drafts → `markSigned` (needs a signed copy) → ACTIVE → EXPIRED / TERMINATED; only `ACTIVE_EDITABLE` fields change once active; files `contract_files`; nightly `runContractEndDates` (job `contracts.daily`).
- Routes: `routes/contracts.ts` (`contractsAdminRouter`, `contractsRouter`, `partiesRouter`). Permissions `contracts.view` / `contracts.manage`; role `CONTRACT_MANAGER`.
- Screens: `pages/contracts/` (Contracts, ContractDetail, ContractForm, Parties), `pages/admin/Contracts.tsx`; shared bits in `components/Contracts.tsx` (labels, `PartyForm`, `NewPartyModal`, `useContractSetup`).
- Clause library and templates: `services/contracts/library.ts` (built-in India + GCC clauses and templates, `ensureLibrary` seeds a workspace on first use; clauses with the same `group` are one clause per jurisdiction IN / AE / SA / ALL), `services/contracts/templates.ts` (clause and template CRUD, Word templates: `wordFields` / `saveWordTemplate`, `templatesFor`). Tables `contract_clauses`, `contract_templates`. Permission `contracts.templates`; role `LEGAL`.
- Merge fields: one catalogue in `services/contracts/fields.ts` (`MERGE_FIELDS`, `fieldValues`, `fill`, `amountInWords` — lakh/crore for INR). Written `{{contract.number}}` in clauses, headings and Word files; unknown fields are refused on save. Never add a field anywhere else.
- Drafting: `services/contracts/drafting.ts` — `startDraft` (template + jurisdiction → `contracts.draft`), `saveDraft` (standard / fallback wording always taken from the library, `custom` = edited → `nonStandard`; fallback → `fallback`), `generateDocument` (built with `docx`, or the Word file filled with docxtemplater; PDF via `integrations/office` = headless LibreOffice, optional), `draft.version` vs `generatedVersion` = document out of date (`touchDraft` on contract edits).
- Internal approval: the generic flow engine, subject `contract`; levels in `settings.contracts.approval` (`contractApprovalLevels`, rule fields `contract.value/type/direction/nonStandard/fallback/category`). Statuses DRAFT → IN_APPROVAL → APPROVED → WITH_PARTY → AGREED → SIGNING → ACTIVE; `reopenDraft` withdraws or reopens. People without `contracts.view` may open a contract they are asked to approve.
- Our company on documents: `companyDetails(t)` (settings.contracts.company, falling back to billing details).
- Screens: `pages/contracts/Library.tsx` (ClauseLibrary, TemplatesList, TemplateEditor), `pages/contracts/Drafting.tsx` (`DraftingCard`, `ReopenButton`), wording boxes with a field picker `components/MergeFields.tsx` (`WordingBox`, `Wording`).
- Uploads: `storeUpload(..., { types })` accepts Word .docx only when a caller allows it (contract files, templates); `contractUpload` multer in lib/upload.ts.
- Review by the other party: `services/contracts/negotiation.ts` — `shareForReview` (version rows `contract_versions`, status WITH_PARTY), reviewers by email link + code (`contract_reviewers`: link and session stored as SHA-256, cookie `vg_c`, code limits like supplier sign-in), `reviewView` / `partyComment` / `partyUpload` / `partyRespond` (ACCEPT → AGREED), staff `staffComment` (internal notes) and `decideComment` (accepting proposed wording puts it into the draft as custom wording → DRAFT). Onboarded suppliers see shared contracts in their portal (`vendorContracts`).
- One set of routes for the other party: `reviewRoutes()` in `routes/contractReview.ts`, mounted at `/api/review/session` (link + code) and `/api/vendor/contracts/:id` (supplier portal). One screen: `ContractReview` (`pages/contracts/Review.tsx`, English + Arabic `review.*`). Staff cards: `NegotiationCard` / `SigningCard` (`pages/contracts/Negotiation.tsx`).
- E-signature: connectors in `integrations/esign/` — `email` kind (DocuSign JWT + Connect HMAC, Adobe Acrobat Sign v6, Zoho Sign, Digio for Aadhaar eSign / DSC) and `link` kind (UAE PASS, built-in `test` which adds a certificate page). Credentials sealed in `settings.contracts.esign` (`sealCredentials` / `esignView` never returns secrets). `services/contracts/signing.ts`: `sendForSignature` (other party signs first, then us; table `contract_signatures`, status SIGNING), link signing `startSigning` → provider → `/api/esign/return/:sig/:nonce` → `finishSigning`, email providers via `/api/esign/webhook/:tenant/:provider` (raw body, before CSRF) + job `contracts.esign` every 15 min, `complete` stores the SIGNED file and activates the contract. Connector tests run against recorded answers (`tests/contractsSigning.test.ts`); verify each against the provider's sandbox before going live.
- Managing signed contracts: `services/contracts/manage.ts` — amendments are contracts of type `amendment` (prefix AMD, `typeInfo()`, not an admin-chosen type) under the contract they change, with `contracts.amends`; they reuse drafting/approval/review/signing, and `onSigned()` (the one hook called by `markSigned` and e-signature `complete`) applies them (`applyAmendment`) or sends supplier contracts to the ERP. Obligations (`contract_obligations`, recurrence, reminders) and renewal / notice alerts (`contracts.alerts`, once each) run in `runContractReminders` (job `contracts.daily`). Agreed prices (`contract_prices`, Excel import) and `priceCheck()` for purchase orders and supplier invoices (rule `priceTolerance`); screen `PriceCheckCard` (`components/PriceCheck.tsx`). ERP: `queueStandaloneMessage` in `services/orders/outbound.ts` (kind `CONTRACT`, event `contract.activated`, Oracle `contractUrl` as a BLANKET agreement) — shared with sourcing awards. Built-in library additions reach existing workspaces through `ensureLibrary` (clauses by group + country, templates by `builtInKey`). Screens: `pages/contracts/Manage.tsx` (`AmendmentsCard`, `AmendsCard`, `ObligationsCard`, `PricesCard`, `ErpCard`, `ObligationsList`).

**Shared helpers for lists, numbers and files**:
- Numbers: `lib/numbering.ts` (`nextYearlyNumber` PREFIX-YYYY-0001, `nextRunningCode` PREFIX-00001; advisory-locked) — sourcing events, contracts, parties.
- Excel templates and reading: `lib/excel.ts` (`sheetTemplate`, `readSheet`, `cellValue`, `colName`); screen `ExcelImportModal` (`components/ExcelImport.tsx`, check first, then import).
- Stored files: `storeUpload(tenantId, folder, file)` and `sendStoredFile(res, doc)` in `integrations/storage`.
- History cards: `HistoryCard` (`components/HistoryCard.tsx`).

**Creating suppliers**: `server/src/services/vendors.ts` (`createVendor` with `prefill` / `approved`).
- Used for invites, Excel invites, approved imports and accepted applications.

**Self-registration** ("Become a supplier" links):
- Rules: `server/src/services/applications.ts`.
- Public pages share `SupplierPublicCard` with the invitation sign-in.

**Duplicate check:** `server/src/services/duplicates.ts`.
- Every profile write uses `withIdentity(profile)`.

**Form and document rules:** `server/src/lib/profileEngine.ts`.

**Performance** (load-tested November 2026 — `tools/loadtest/`):
- Lists are paged on the server: the vendor list takes `page` / `pageSize` (50, max 200) and returns `total`; pickers use `/staff/vendors/options`. Screen: `Pager` (`web/src/components/Pager.tsx`). Never return a whole table to the browser.
- Short-lived figures: `cached(key, ttl, fn)` in `lib/cache.ts` (dashboard, "needs attention" via `approvedVendorFlags` in lifecycle.ts, AI peer comparison). Keys start `vendors:<tenantId>:`; `onAudit` in `lib/audit.ts` drops them when a vendor changes.
- Auctions rank from each bidder's best bid in SQL (`bestBids` in live.ts) — never load the whole bid history per request.
- Don't write on read (opening a supplier recalculates risk but only writes when it changed, and never bumps `updated_at`).
- `DATABASE_POOL_MAX` sets connections per API instance; rate limits are per instance (in memory).

**Security rules** (tested by `tests/hardening.test.ts` and `tools/loadtest/sec.py` / `authz.py`):
- Every CSV goes through `toCsv` (lib/erpMapper.ts), which neutralises formulas; Excel exports write text cells only.
- URLs from outside (ERP attachments, logos) must be http(s); error responses list at most 20 problems; `/api` answers are `no-store`.
- Someone not invited to an event gets 404 before any other check (no hint that it exists or is running).
- Supplier sign-in codes: 5 tries per code, 3 codes a minute / 10 an hour, 20 wrong codes a day per supplier.

## Other conventions

- Every change ships with tests:
  - server: `cd server && npx vitest run`
  - browser: `npx playwright test`
- User-facing text is plain English. Supplier-facing text also needs Arabic (`npm run i18n:check`).
- Schema changes:
  1. Edit `server/src/db/schema.ts`.
  2. Run `npx drizzle-kit generate --name <what>`.
  3. Migrations run on deploy.
