# VendorGate algorithms

Generated from the algorithm definitions (`server/src/lib/algorithms.ts`) — what Administration shows and what the checks run. Regenerate with `npm run -w server docs:algorithms`.

## Invoice duplicate check

*Invoices* — Stops the same invoice being paid twice: exact repeats are blocked, near repeats are flagged for a person to look at.

**Runs:** On every save and submit (AP), on supplier-portal submission, and when an invoice arrives by email or bulk upload. One shared check for every source.

### How it works

1. **Normalise the new invoice** — Invoice number → key (upper case, letters and digits only) and core (the serial: the last run of digits that isn’t a year or financial year such as 2026 or 26-27, leading zeros dropped). Supplier → party and legal identity (PAN taken from the GSTIN, or the tax number). Amount, invoice date, IRN and the PDF’s fingerprint (SHA-256).
2. **Find candidates** — Same workspace and same kind (invoice, credit note or debit note); same party or same PAN / tax number; invoice date within the look-back; not cancelled or rejected (a corrected invoice may be sent again). Drafts count only for warnings. IRN and file fingerprint are compared across all suppliers.
3. **Apply the rules** — Each earlier invoice is matched against the rules in order; the first rule it meets applies. Block = an error (it can’t be submitted); Warn = an exception (touchless is skipped and a person must look); Off = not checked.
4. **Show the matches** — The check names the matching invoices (up to three per rule) with their date and amount.
5. **A person decides** — “Not a duplicate” with a note clears that pair — recorded with who and when, and not raised again. Otherwise the invoice is cancelled or rejected.

### Settings (Administration)

| Setting | Default | Range | Meaning |
|---|---|---|---|
| Look-back | 18 months | 1–60 | Earlier invoices dated within this many months are compared. |
| Date window | 7 days | 0–90 | How close the invoice dates must be for P2, P3 and P4. |
| Amount tolerance | 1 currency | 0–100000 | Totals this close count as the same amount. |
| Short numbers | 4 digits | 1–10 | In P1 and P4, a core number shorter than this many digits (1, 07, 123) matches only with the same amount too — short numbers repeat across unrelated invoices. |
| Look-alike characters | On | On / Off | In P2, treat O and 0, I / L and 1, S and 5, B and 8 as the same (typing and PDF-reading slips). |

### Rules

| Rule | Default | Can be set to | Matches when | Catches |
|---|---|---|---|---|
| H1 Same number | Block | Block / Warn | Same supplier, same kind, same number key on a submitted invoice | Re-entered invoice: INV-001 = inv 001 = INV/001 |
| H2 Same IRN | Block | Fixed — an IRN is unique by law | Same e-invoice IRN on another invoice (any supplier) | The same e-invoice twice (an IRN is unique by law) |
| H3 Same PDF | Block | Block / Warn / Off | The same PDF file (fingerprint) on another invoice (any supplier) | The same file mailed twice, or uploaded and mailed |
| P1 Number written differently | Warn | Block / Warn / Off | Same supplier; same core number; key differs (a core shorter than “Short numbers” also needs the same amount) | KST/2026/1187 vs 1187; INV-001 vs 1 for the same amount |
| P2 Number one slip apart | Warn | Block / Warn / Off | Same supplier; numbers one slip apart — two characters swapped, one added or dropped, or look-alike characters — with the same amount or dates within the window. One changed character counts only with the same amount and dates within the window (consecutive numbers such as 001 and 002 are normal and not flagged on their own) | Typing and PDF-reading slips: 4512 vs 4521, INVO12 vs INV012, 1187 vs 11877 |
| P3 Same amount, close dates | Warn | Block / Warn / Off | Same supplier; same total (within the tolerance); dates within the window; different number | The same bill sent again with a new number (a monthly bill 30 days apart is not flagged) |
| P4 Same supplier, another code | Warn | Block / Warn / Off | Another party with the same PAN / tax number; same number key or core (as in P1), or same total with dates within the window | A supplier set up twice (two codes or sites) and billed through both |
| P5 Same PO lines again | Warn | Block / Warn / Off | Same purchase order; the same lines with the same quantities and prices as an earlier invoice | The same delivery billed twice under different numbers |
| P6 Same note again | Warn | Block / Warn / Off | A credit or debit note against the same invoice for the same amount as an earlier note | A credit note entered twice, or a debit note raised twice |

### Worked examples

| Already in VendorGate | New | Rule | Result |
|---|---|---|---|
| KST/2026/1187 · 01 Nov · 1,79,950 | kst 2026 1187 · 01 Nov · 1,79,950 | H1 | Blocked — already submitted |
| KST/2026/1187 · 01 Nov · 1,79,950 | 1187 · 01 Nov · 1,79,950 | P1 | Possible duplicate |
| KST/2026/1187 · 01 Nov · 1,79,950 | KST/2026/1188 · 03 Nov · 22,000 | — | Clean — the next invoice in the supplier’s series |
| KST/2026/1187 · 01 Nov · 1,79,950 | KST/2026/1178 · 02 Nov · 1,79,950 | P2 | Possible duplicate (two digits swapped) |
| KST/2026/1187 · 01 Nov · 1,79,950 | KST/2026/1201 · 05 Nov · 1,79,950 | P3 | Possible duplicate (same amount, 4 days apart) |
| Rent PE/0412 · 01 Oct · 2,95,000 | Rent PE/0498 · 01 Nov · 2,95,000 | — | Clean — monthly bill, 31 days apart |
| KST/2026/1187 under SUP-00002 | KST/2026/1187 under SUP-00019 (same PAN) | P4 | Possible duplicate — supplier set up twice |

### Behaviour

- Warnings never stop entry; they need a person: touchless is skipped and the AP review level applies.
- “Not a duplicate” stores who, when, why and the matched invoices; the same pair is not flagged again.
- Email and bulk arrivals are checked on arrival, so the flag shows before anyone opens the invoice.
- Debit notes are numbered by VendorGate, so the number rules (H1, P1, P2) don’t apply to them.
- Candidates come from indexed columns (party, PAN, IRN, fingerprint, date); similarity is worked out on at most 2,000 earlier invoices.

## Email inbox: matching and reading

*Invoices* — How an emailed invoice is turned into a draft: which attachments count, how the supplier and purchase order are found, and what is read from the PDF.

**Runs:** For every email that reaches the workspace’s invoices address or the mailbox VendorGate reads.

### How it works

1. **Record the email once** — By its Message-ID — the same email forwarded or fetched again is not processed twice.
2. **Pick the attachments** — PDFs, and PDFs inside a .zip; scanned images (PNG / JPG) when allowed and above the minimum size, so logos and signatures are skipped. At most the set number per email.
3. **Find the supplier** — The sender’s address against each supplier’s email, accounts email and contacts; then, if allowed, the sender’s domain when exactly one supplier uses it (free-mail domains never count); then a GSTIN printed on the invoice; then the purchase order’s supplier.
4. **Find the purchase order** — A PO number (4+ characters) in the file name, the subject, the email text or the PDF text — only when exactly one order matches.
5. **Read the PDF** — If allowed: invoice number, invoice date, total, IRN and GSTINs from the PDF’s text (no AI; scans have no text). AP checks them before submitting.
6. **Make the draft and check it** — One draft per attachment, with the email linked. All invoice checks run at once — a file already received is not made into a second draft.

### Settings (Administration)

| Setting | Default | Range | Meaning |
|---|---|---|---|
| Drafts from unknown senders | On | On / Off | Make drafts (without a supplier) from senders that match no supplier. Off = record the email and make nothing. |
| Match by email domain | On | On / Off | A sender from a supplier’s domain (accounts@kirloskar.com for a supplier with sales@kirloskar.com) counts as that supplier when only one supplier uses the domain. |
| Read the PDF | On | On / Off | Fill the number, date, total and IRN from the PDF’s text. |
| Accept scanned images | On | On / Off | PNG and JPG attachments become invoices too. |
| Smallest image | 40 KB | 0–5000 | Images smaller than this are logos or signatures and are skipped. |
| Attachments per email | 20 | 1–100 | More than this and only the first are taken (the email is still recorded). |

### Behaviour

- Nothing is sent back to the sender.
- Email from a supplier on hold still arrives; the hold shows as a check on the draft.

