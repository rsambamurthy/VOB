# Country packs

Everything in VendorGate that differs by country lives in a **country pack** under `server/src/countries/`.
The rest of the app (workflow, approvals, change requests, documents, ERP connectors, purchase orders) is shared.

## Two countries per vendor

| | Decided by | Controls |
|---|---|---|
| **Home country** | the workspace (`tenants.country`, chosen when the workspace is created) | currency and number/date format, which suppliers are domestic, the starting onboarding template, the privacy notice and its law, the ERP record (e.g. `INDIA_LOCALIZATION`) |
| **Supplier country** | the supplier's answers (`basic.supplierCountry`, `bank.bankCountry`) | postal-code and bank-account formats, bank branch code in the ERP record (IFSC for Indian banks) |

Field formats, online checks and readable document types are **global by name**: any workspace can use India's
GSTIN check or GST-certificate reading for its Indian suppliers.

## Layout

```
countries/
  types.ts      CountryPack interface
  list.ts       country names ↔ ISO codes ↔ currency
  base.ts       shared building blocks every pack inherits (email, phone, URL, SWIFT, IBAN, year, generic postal/bank formats)
  registry.ts   PACKS list, inheritance, merged views used by the app
  in/           India
    validators.ts  GSTIN (checksum), PAN, TAN, CIN/LLPIN, IFSC, UPI, Udyam; PIN and bank formats; PAN-in-GSTIN cross-check
    checks.ts      GSTIN / PAN / penny-drop / MCA checks; Surepass or test-mode provider
    documents.ts   GST certificate, PAN card, cheque, incorporation, Udyam — what the AI reads from each
    template.ts    starting onboarding template (GST, TDS, DTAA sections)
    privacy.ts     DPDP privacy notice
    index.ts       the pack: currency INR, locale en-IN, ERP India localisation
```

## Adding a country

1. Create `countries/<iso>/index.ts` exporting a `CountryPack` (`extends: 'GCC'` to inherit a shared regional pack).
2. Add only what differs: `validators`, `formats`, `checks` + `checkProvider`, `documents`, and — if workspaces can be
   based there — `homeCountry: true`, `template`, `privacy`, `erp`.
3. List it in `PACKS` in `registry.ts`. Names of validators, checks and document codes must be unique across packs (checked at start-up).
4. Add a test next to `server/tests/countries.test.ts`.

Nothing else in the app needs to change: the configuration editor, Verify buttons, reviewer checks panel, periodic
re-checks, AI document reading, ERP export and formatting all read from the registry.

## Not yet pack-driven (next phases)
- Working week for approval deadlines and auto-accept (packs declare `weekend`; deadlines still count plain hours).
- Field masking/encryption list (`lib/fieldCrypto.ts`) and the vendor register report's GSTIN/PAN/IFSC columns.
- Choosing a country on the self-service sign-up page (workspaces from sign-up are India until a second home country exists).
