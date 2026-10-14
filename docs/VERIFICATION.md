# Live verification providers

Every check starts in **test mode**. A check goes live as soon as a provider for it is set up in the server settings
(environment variables). **Admin → Integrations** shows, check by check, which are live and which are still in test mode.

For each check, VendorGate uses the first of these that is set up:

1. Its own **registry connector** (`REGISTRY_CONNECTORS`).
2. A **built-in provider**:
   - Wathq for the Saudi CR (`sa_cr`).
   - OpenSanctions for sanctions screening (`sanctions`).
   - Surepass for India (`gstin`, `pan`, `bank`, `cin`).
3. The **KYC aggregator** (`KYC_AGGREGATOR_URL`), if it is set to answer that check.
4. **Test mode.**

Results are cached for `KYC_CACHE_HOURS` (default 24). Calls are limited per vendor per check per day by `KYC_DAILY_LIMIT` (default 10).

## Check names

| Check | Kind | Inputs sent |
|---|---|---|
| Sanctions screening (Gulf workspaces) | `sanctions` | `name`, `country`, `owners` (owner names separated by `\|`) |
| Gulf bank account (IBAN) | `gcc_iban` | `iban`, `holder` |
| Saudi CR / VAT | `sa_cr` / `sa_vat` | `cr` / `vat` |
| UAE TRN | `ae_trn` | `trn` |
| Bahrain CR / VAT | `bh_cr` / `bh_vat` | `cr` / `vat` |
| Qatar CR / TIN | `qa_cr` / `qa_tin` | `cr` / `tin` |
| Kuwait CR | `kw_cr` | `cr` |
| Oman CR / VAT | `om_cr` / `om_vat` | `cr` / `vat` |
| India GSTIN / PAN / bank / MCA | `gstin` / `pan` / `bank` / `cin` | see `countries/in/checks.ts` |

## Sanctions screening: OpenSanctions

```
SANCTIONS_PROVIDER=opensanctions
OPENSANCTIONS_API_KEY=...
OPENSANCTIONS_DATASET=sanctions      # 'default' also covers PEPs, debarment and crime lists
OPENSANCTIONS_THRESHOLD=0.8          # 0–1; lower catches more possible matches
```

- **What is screened:** the supplier as a company, and up to three listed owners as people, in one call to the
  [matching API](https://www.opensanctions.org/docs/api/matching).
- **No match:** the result is "Clear".
- **A match:** the result is "Possible match", with the matched entity, score and lists. A reviewer must decide before approving.
- **When it runs:** automatically when the supplier submits, and again at periodic re-checks.
- **Who sees it:** staff only. Suppliers never see sanctions results.

## Saudi CR: Wathq

```
WATHQ_API_KEY=...
WATHQ_CR_BASE_URL=https://api.wathq.sa/v5/commercialregistration
```

- **Request:** `GET {base}/info/{cr}?language=en`, sending the key in the `apiKey` header.
- **Fields read:**
  - The name comes from `name` and the status from `status.name`.
  - The status must be "active", "نشط" or "قائم"; any other status gives "found, but not active".
  - `expiryDate` and `crNationalNumber` are kept with the result.
- **Before going live:** confirm these paths against the OpenAPI file in your Wathq subscription. If they differ, define
  `sa_cr` in `REGISTRY_CONNECTORS` instead (below); that definition takes precedence.

## Registry connectors (`REGISTRY_CONNECTORS`)

A JSON array of HTTP lookups. Use one per check, for registries you have direct API access to:

```json
[
  {
    "kind": "bh_cr", "name": "sijilat", "source": "Sijilat",
    "method": "GET",
    "url": "https://api.example.bh/cr/{cr}",
    "headers": { "Authorization": "Bearer ${SIJILAT_TOKEN}" },
    "notFoundStatus": [404],
    "namePath": "data.commercialName",
    "statusPath": "data.status",
    "activeValues": ["ACTIVE"],
    "dataPaths": { "expiryDate": "data.expiry" }
  }
]
```

How the fields work:

- **`url` and `body`:** `{input}` placeholders take the check's inputs (see the table above).
- **`headers`:** `${ENV_VAR}` placeholders are read from the environment, so keys stay out of the JSON.
- **Result:**
  - An HTTP status listed in `notFoundStatus` gives "not found".
  - A status outside `activeValues` gives "found, but not active".
  - Otherwise the result is verified, with the name on record taken from `namePath`.

## KYC aggregator / middleware (`KYC_AGGREGATOR_URL`)

One service that answers any check. It can be a commercial aggregator's adapter, or a small service of your own that
calls Tamm, Sijilat, MOCI, a bank-account verification API, and so on.

```
KYC_AGGREGATOR_URL=https://kyc.example.com
KYC_AGGREGATOR_KEY=...               # sent as "Authorization: Bearer ..."
KYC_AGGREGATOR_KINDS=*               # or a list: sa_vat,ae_trn,gcc_iban
```

With `*`, the aggregator answers every check that has no other provider. India's checks stay on Surepass when
`KYC_PROVIDER=surepass`.

**Request** (`POST {KYC_AGGREGATOR_URL}/checks/{kind}`):

```json
{ "kind": "qa_cr", "input": { "cr": "123456" }, "legalName": "West Bay Trading W.L.L." }
```

**Response** (HTTP 200):

```json
{ "status": "VERIFIED", "message": "Active on MOCI", "nameOnRecord": "WEST BAY TRADING W.L.L.", "data": { "expiryDate": "2027-03-01" } }
```

The response fields:

- **`status`:** one of `VERIFIED`, `NOT_FOUND` or `ERROR`.
- **`message`:** shown to reviewers (and to suppliers, except for sanctions).
- **`nameOnRecord`:** optional. VendorGate compares it with the supplier's legal name, or with the account holder for
  IBAN checks, and flags a match below 70%.
- **`data`:** optional extra values, kept as text.
