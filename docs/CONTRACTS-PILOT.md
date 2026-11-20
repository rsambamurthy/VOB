# Contracts — pilot checklist

Use this to take one business unit live on Contracts. Tick each line in a test workspace first, then in the pilot workspace.

## 1. Before the pilot

- [ ] Plan or licence includes **Contracts** (and **AI** if contracts will be read with AI). The *Contracts* plan works without supplier onboarding.
- [ ] Administration → **Contracts**: switch on; choose the contract types the unit uses.
- [ ] Options: decide each one — customer contracts, master agreements, Excel import, templates, Word templates, internal approval,
      review by the other party, e-signature, obligations, renewal alerts, price checks (needs purchase orders), ERP (needs ERP integration),
      reading uploaded contracts (masked before any AI).
- [ ] Rule defaults: notice period, renewal term, *expiring* window, value required, price tolerance, notice reminder days. Lock what Legal requires.
- [ ] **Our company on contracts**: legal name, registration and tax numbers, address, city, signatory.
- [ ] **Contract approval** levels, tried with the tester (value bands, Legal on changed wording or fallback clauses).
- [ ] Roles: give *Contract Manager* to the contract team and *Legal Counsel* to Legal (Administration → Roles).
- [ ] Clause library: Legal has read the built-in India / GCC clauses and changed what the company does not accept.
- [ ] Templates: the unit's top three contract types each have a template (built-in or the company's own Word file).

## 2. E-signature (if used)

- [ ] Provider chosen (DocuSign, Adobe Acrobat Sign, Zoho Sign, Digio for Aadhaar eSign / DSC, UAE PASS).
- [ ] Credentials entered with **Sandbox** ticked; **Test the connection** passes.
- [ ] Webhook URL from the settings page given to the provider (DocuSign, Adobe, Zoho, Digio).
- [ ] One full test in the provider's sandbox: other party signs, then us; the signed copy arrives and the contract becomes **Active**.
- [ ] Only then untick **Sandbox**. *Test signing* is never used for a real contract.

## 3. Bringing existing contracts in

- [ ] Parties imported from Excel (or linked to onboarded suppliers); look-alikes checked.
- [ ] Contracts imported from Excel with dates, value, notice and renewal terms; the signed copy uploaded to each.
- [ ] For contracts on the other party's paper: **Read the contract** on the uploaded Word / PDF file, check each suggestion against
      the evidence sentence, then **Use the ticked values**. Scans are not read — key the terms in.
- [ ] Obligations added for the contracts that have payments, reports or service levels; owners set.
- [ ] Agreed prices added (or imported) for rate contracts, matched on the ERP item code.

## 4. Privacy check for AI reading

- [ ] With *Read uploaded contracts* on, open one reading and click **What the AI saw**: party names, numbers, emails, phones,
      accounts, amounts and dates show as [PARTY-1], [DATE-2]… and nothing identifying is left.
- [ ] Without an AI provider configured, readings show *Read with VendorGate's rules* and nothing is sent anywhere.

## 5. During the pilot (2–4 weeks)

- [ ] Every new contract for the unit starts in VendorGate (draft → approval → other party → signature).
- [ ] At least one contract goes through review by the other party with comments and a new version.
- [ ] At least one amendment is made and signed, and its changes reach the contract.
- [ ] Renewal and notice alert emails reach the owners; obligation reminders arrive before the due date.
- [ ] Purchase orders and invoices from suppliers with agreed prices show **Contract prices**; lines above the price are followed up.
- [ ] Signed supplier contracts reach the ERP (check **ERP** on the contract; **Send again** if needed).
- [ ] Contracts → **Reports** reviewed weekly with the unit head: value under contract, ending in 90 days, overdue obligations,
      time to sign, prices above contract. **Download Excel** for the meeting.

## 6. Go / no-go for the rest of the company

- [ ] No contract signed outside VendorGate for the unit during the pilot.
- [ ] Time to sign is known per contract type and acceptable.
- [ ] No missed notice date and no overdue obligation without an owner.
- [ ] Legal is satisfied with the clause library and the approval levels.
- [ ] Users have read the user manual's Contracts chapter and the in-app help (**?** on each Contracts screen).

## Tested before release

- Server tests for configuration, drafting, approval, review, signing connectors (recorded answers), amendments, obligations,
  prices, ERP, reading (masking, nothing identifying reaches the AI, odd and oversized files) and reports.
- Browser tests for switching Contracts on, a party and contract, signed copy, reading a scan, and the reports page.
- Load test on a local copy at pilot size: 5,000 contracts, 3,000 parties, 30 contract managers and 20 reviewers alongside the
  existing onboarding, sourcing and auction traffic (`tools/loadtest/`).
- Security sweep: review links and codes, another contract's files, e-signature callbacks, reading odd files, Excel exports,
  and every new route called by people who should not reach it (`tools/loadtest/sec.py`, `authz.py`).
