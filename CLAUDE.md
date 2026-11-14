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
