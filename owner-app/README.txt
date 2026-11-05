PRIMEOPS ADMINISTRATION - BROWSER BACKEND (WINDOWS OPTIONAL)

RECOMMENDED: On the server, open http://localhost:3001/admin/ in a browser.
For remote access, use an SSH tunnel or private VPN. Never publish port 3001.
- The public client port returns 404 for administrator pages and APIs.
- There are no backend links in the client app.
- Sign in with your existing platform administrator / former Owner login.
- Owner means the owner of PrimeOps. Client companies are not platform owners.
- Add client creates a client, main account and active annual licence together.
- Open Clients, then Open account to renew, manage plans/features or add
  buildings/checklists. The banner identifies the account you are working in.
- Back to clients exits the account. Home, Add client, PrimeOps team and Change
  password are platform pages; opening them closes the client workspace.
- Home offers the same PrimeOps branding, dark/light themes and quick-access
  cards as the client app.
- PrimeOps team: only the owner can add Administrator/Supervisor staff, edit
  their roles, reset passwords or deactivate/reactivate accounts. Each has a login.
- Staff manage clients but cannot manage staff or change ownership. Client users
  are separate: open a client, then Client operators to create staff or edit roles,
  active status, buildings and manager section grants. Main admins are protected.
- Office Administrators default to Leasing and Billing within assigned buildings
  and approved features; no unit number or resident details are required.
- Students and tenants are created and managed only in the client app, not here.
- No separate app, manual token generation or copying is required.
- Platform access works even if a client's licence is missing or expired.
- Sessions stay in memory only; refresh/sign-out requires signing in again.
- Lost login: a server operator runs:
  docker compose exec app node server/reset-platform-admin.cjs primeops-admin
  Enter and confirm a new password at the hidden prompts.
  This does not change any client accounts, licences or signing keys.

OPTIONAL WINDOWS INTERFACE

1. Extract the entire ZIP.
2. Open PrimeOps Owner.exe. Windows may warn because this test build is unsigned.
3. Enter http://localhost:3001 through your private connection and Connect.
4. First setup only: enter the server's initial administrator credentials,
   then choose a separate PrimeOps administrator login (at least 12 characters).
   Registration creates the signing key and activates the initial company's
   first annual licence automatically.
5. Sign in with your platform administrator login.

COMPANIES
- Add client: enter client name, unique company code, main username/password.
- Registration creates the main admin and activates its first annual licence
  in one step. If activation fails, no partial company is registered.
- The new company starts blank and can request any PrimeOps feature.
- Give the company its code and admin credentials through a secure channel.
- Its users enter that company code in PrimeOps, then sign in.
- Existing company codes and records stay unchanged.

LICENCES
- First licence registration is automatic when the main admin is created.
- To renew, open the client account, then Renew licence for one year.
- No token files, copying or separate activation are needed. Devices receive
  the licence when connected. Manual token transfer remains optional.
- Older companies without a token show Register annual licence once.
- Approve renewal requests in the Licence tab.
- You can optionally allow Free in-app test renewal for the selected company.
  It is disabled by default. Turn it off before production charging.
- Accounts supports issued invoices, manual payments and optional hosted Payfast
  credit/debit-card checkout. Subscription invoices are automatic on registration
  and then on the 1st of each UTC month, without proration.
  Existing clients show TEST / DEMO invoices for presentations only: no emails,
  real collection, arrears blocking or inclusion in real platform totals.
  New clients use live billing. Complete seller Invoice setup and client billing
  details; missing setup is reported and retried every minute.
  Restarts catch up missed months without duplicate service-month invoices.
- Account status & dates: manually set Client active and actual licence/billing
  access start/end dates in UTC. End must follow start; a change reason is required.
- Inactive blocks client sign-in/ordinary online APIs without deleting records.
  Future starts require a licence refresh when the period begins.
- Changes are signed and audited; stale edits must be refreshed before saving.
  Use current client builds supporting custom-period (v2) licences.
- Connected devices receive changes on their next check. Disconnected devices
  keep their cached access until its expiry or reconnection.

SUBSCRIPTIONS AND FEATURES
- Subscriptions: Basic R450/month up to 10 active users, Building Managers
  R850/month up to 20, Operations R1500/month unlimited. Final ZAR prices include
  VAT where applicable. Every active account counts, including admins.
- Choose a plan during registration, or approve company plan requests later.
- Plan changes affect unissued charges only; issued invoices remain unchanged.
- Demo charges use the same tier prices and clearly marked downloadable PDFs.
- Features: company admins select 1-5 free initial features from Home.
- Approve activation in Features. Later additions show a once-off test
  admin fee of R100 per feature. No payments are collected.
- New catalogue features are offered to existing clients, not auto-activated.
- Existing client users, passwords, checklists and records are retained.
- Open a client > Client operators > expand the account > Set / reset client
  password. Enter and confirm 12+ characters, at most 72 UTF-8 bytes.
- Owner/Supervisor can reset the protected main client administrator password.
  Platform Administrators can reset other client staff passwords, not residents.
- Old passwords are not needed or displayed. Resets are audited without secrets,
  require online sign-in again and persist after backend restarts.
- Roles, assigned buildings, active status, licences and billing do not change.
- A disconnected device learns the reset only after reconnection; its offline
  password cache updates after a successful online sign-in.

ACCOUNTS AND DEBTORS
- Invoice setup: Owner configures the actual South African seller legal/VAT
  details before invoicing. Verify compliance with your accountant.
- Clients upload/review their billing particulars through PrimeOps statement.
  New invoices automatically snapshot those details; old invoices do not change.
- Invoice dates/description default; enter the final inclusive total and submit.
  Blank reference generates a unique PO-number. View/print/save PDF in app.
- Optional SMTP sends an HTML invoice attachment; check each invoice's email
  status and retry explicitly if needed. Acceptance is not inbox delivery.
- SMTP/Payfast credentials and public HTTPS origin are private server environment
  configuration; see README.md and .env.example. Never publish port 3001.
- Sandbox card tests never settle live invoices. Only verified Payfast live
  notifications record cash; browser returns are not proof of payment.
- Set monthly forecasts and record advance receipts in Account & payments.
  Home shows projected income, overdue clients and clients paid ahead.
- Home / Accounts: all-time and current UTC-month income received, outstanding
  balances and arrears in ZAR. Open a client > Account & payments for its ledger.
- Owner/Supervisor: edit debtor legal/registration/VAT details, billing address,
  accounts contact, payment terms and internal notes; create manual invoices.
- Administrators can view accounts and record payments, not issue invoices.
- Record received payments against invoices; partial payments are supported.
  Split receipts across invoices with distinct references. No overpayments,
  future-dated payments or automatic bank/email/payment-gateway integration.
- Unpaid invoices block the workspace after seven complete UTC days following
  their due date. Due 1 November means blocking starts 9 November at 00:00 UTC.
- Full settlement restores billing access automatically. Licence validity and
  manual active/inactive status remain independent.
- Owner/Supervisor can grant/revoke dated payment-agreement extensions with
  their own password and a reason. Debt remains; expired agreements block again.
- The same password-confirmed roles can reverse payments or void unpaid
  invoices. History is retained and stale/concurrent edits are rejected.
- Debtor internal notes are private. The client's main admin has a read-only
  PrimeOps statement, including when billing-blocked but otherwise licensed/active.
- Existing clients start without charges. Offline devices only learn new blocks
  on reconnection; known blocks deny cached work and hold pending changes for review.

BUILDINGS AND CHECKLISTS
- Open the client account, then Buildings & checklists.
- Add buildings on their behalf.
- Create questions or import a JSON checklist; choose all company buildings
  or selected buildings and Save. Check the company label before saving.
- JSON format:
  {"title":"Monthly check","questions":[
    {"label":"Emergency lights working?","type":"yes-no-na","photo":true}
  ]}
- Types: yes-no, yes-no-na, pass-fail-na, text, textarea, number, rating, date.
- The client app supports PDF (including scans), Excel .xlsx, Word .docx,
  CSV/TSV, text, JSON and image checklist imports. It generates editable questions
  and a spreadsheet preview, keeping readable source columns and values.
  Review OCR text before saving; exact fonts/page design are not reproduced.
- Company admins/MMs can create/import their own checklists in Building checks.

NEW CLIENT FEATURES
- Security calls and in-app reports, resident visitor registration, meter checks,
  asset management, incident reporting and contractor management are available
  through the existing feature request/approval workflow.
- Client administrators choose Students, Tenants or Both and their security
  number under Home > Features > Client settings: residents & security.
- Visitors require administrator/manager approval before check-in and check-out.
- Existing building assignments apply, including multiple buildings per user.
- New operation screens require a live connection. No SMS/email dispatch is
  configured. A telephone link opens the device dialler.

HOSTING AND BACKUPS
- This desktop app administers an already running PrimeOps backend.
  It does not install Docker, provision cloud servers, or run the backend.
- Use HTTPS for a hosted server. HTTP is allowed only on localhost for testing.
- Back up the database, server .env/JWT_SECRET and all report folders.
  The signing key is encrypted on the server; changing JWT_SECRET without
  migrating the key prevents future token generation.
- Keep your platform credentials private. Clients are not PrimeOps owners or staff.
- Sign out when finished. Platform login expires after two hours.
- Existing file-generator users must migrate deliberately if they have already
  activated a licence with a manually held signing key.
