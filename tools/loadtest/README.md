# Load and security tests

Used for the November 2026 load / security review. Run against a **copy** — never the live site.

1. Start a throw-away server with demo data in development mode (so supplier sign-in codes are shown), e.g.
   `DATABASE_URL=…/vendor_onboarding_load_e2e npm run -w server e2e:start` on port 4800 with `ENCRYPTION_KEY` set.
2. `python3 setup.py` — adds 3,000 suppliers, staff and supplier sessions and a reverse auction with 50 accepted bidders; writes `tokens.json`.
   Then `python3 contracts_setup.py` — switches Contracts on and adds 3,000 parties, 5,000 contracts at every stage, 2,500 obligations (on the active ones),
   20 contracts with the other party (a signed-in reviewer each) and a Word contract to read.
3. Stop it and run `ENCRYPTION_KEY=… ./run.sh` — restarts the API in **production** mode and runs `pilot.js` (k6):
   150 staff + 50 suppliers browsing with think time, 49 bidders in one live auction, and (after `contracts_setup.py`)
   30 contract managers (lists, search, a contract, obligations, reports, reading a Word contract) and 20 reviewers. `SCALE=2` doubles the browsing users,
   `CONTRACTS=0` leaves the contracts scenarios out, `SCRIPT=bidstorm.js` sends bids as fast as possible. Prints latency per screen.
4. `node sse.mjs` (alongside) holds 50 live-update streams and measures how fast a bid reaches them.

Security: `sec.py` (headers, CSRF, sign-in, sessions, injection, uploads, SSRF, sealed bids, exports, disclosure, and Contracts:
review links and codes, the other party's access, e-signature callbacks, reading odd files, the report export) and
`authz.py` (every route from `npx tsx list-routes.ts > routes.json` called as: nobody, another workspace's admin,
suppliers, a viewer, a tax reviewer and a contract reviewer of another contract; `contracts_fixture.py` makes the contracts both use) — both against a production-mode server on port 4801 with the demo data.
Tools: k6, Python 3 with requests, psql.
