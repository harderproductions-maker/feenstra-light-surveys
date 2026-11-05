# Leasing & Tenant Management: opt-in test workflows

## Status and architectural fit

The foundation (`001-leasing`), additive test migration (`002-leasing-test`)
unit audit fields (`003-unit-audits`) and the parking audit register
(`004-parking-audits`) support the online Leasing screens/API. Both are explicit per-client migrations;
startup does not apply them. The test API also requires the company code in
`LEASING_TEST_COMPANIES` and the company's `leasing` feature enabled.

The client profile layer provides a `leasing` section: client Admins have
access when the company feature is enabled, and Portfolio/Building Managers
include it in their role defaults. Explicit manager sections can grant or remove
it, and assigned buildings still scope manager access. Office Administrators
default to Leasing/Billing; linked residents see only their own leases/signatures.
Permission selection does not apply migrations. Maintenance and Operations
Manager defaults exclude leasing.

## Test setup and limitations

Back up first, rehearse on an isolated database, then provision each approved
client explicitly using the existing private `DATABASE_URL`:

```sh
node server/leasing-test-migration.cjs --company CLIENT-CODE --apply
```

This applies/checks all three migrations, but does not enable features. Add the approved
codes to `LEASING_TEST_COMPANIES` (comma separated), enable the company `leasing`
feature, and restart the app. Billing actions also require the enabled `billing`
feature and account permission. Do not select arbitrary/all clients.

- Registers, draft/edit/activate/renew/notice/terminate, date-derived occupancy,
  tenant codes/account links and move-in/vacate/inspection/renovation schedules
  use existing client schemas and assigned buildings.
- Rent, recurring charges, payments/credits and deposits/refunds are **TEST only**
  in a separate ledger. Recurring billing runs manually through a selected date,
  is idempotent per lease/charge/month, and uses full-month amounts without
  proration. There is no automatic job, live collection or email.
- Upload approved PDF/DOCX standard templates or lease attachments unchanged.
  Drawn PNG signatures require explicit consent and exact current version;
  account/name/timestamp, accepted terms/documents and historical signatures are
  retained. Every linked tenant can sign separately. This is not a certified
  signature service or a claim of legal validity.
- PDF reports, Excel registers/ledger/audits, and per-lease ZIP originals/signature
  images plus audit PDF provide retention exports.
- **Import existing data** reads Excel/PDF/scans/CSV/Word locally with shared OCR.
  Choose worksheet/header, map fields, edit the preview, and confirm review.
  Import buildings, units, tenants, lease drafts, schedules, then opening TEST
  balances. Use exact building names/IDs, unit numbers, tenant codes and lease
  numbers; dates are `YYYY-MM-DD`, amounts decimal without currency/grouping.
  Limit 500 rows/30 columns/25 MB. No password import, overwrites (except
  building/parking audit updates below), automatic
  identity matching or automatic activation. Bad rows reject the entire batch;
  retrying the same batch does not duplicate it. Original extracted cells,
  unmapped columns and corrected rows are retained; main admins can export these
  in Excel. The original source file itself is not retained by register import.
  PDF/OCR can misread irregular layouts: users must correct errors or reformat
  the source; no inferred data is silently accepted.
- Unit/building audits, tenant, lease and schedule imports require an explicit
  selected assigned building, including single-building accounts. Mapped building
  values must match it. Header detection recognises compact unit audit headings
  such as `UnitNumber`, `UnitType`, `ParkingBays` and `FloorArea`. Unit floor,
  type, bedroom/bathroom/parking counts, area in square metres and audit occupancy
  status are retained, editable and included in building schedules/Excel.
  Audit status is not a lease; live occupancy remains separately derived.
- Users choose the file type: building audit (unit schedule), parking audit,
  tenant list, lease schedule, works schedule, opening balances or buildings
  list. A clear heading mismatch with another type is flagged. Building audits
  list Unit number first (preview, schedule, PDF, Excel). Parking audits use
  `BayNumber`, `Level`, `BayType`, `AssignedUnit`, `Status` and `Notes`; the
  assigned unit must exist in the selected building.
- Re-importing a building or parking audit updates existing units/bays with the
  same number in that building and adds new ones; blank cells keep current
  values, a number repeated in one file is rejected, and before-values are kept
  in the activity audit. The preview marks each row New or Update existing.
  Each unit shows its allocated bays from the parking audit, updated as bays
  are imported, edited or removed.

The existing application uses CommonJS/Express, PostgreSQL schemas per client,
browser ES modules and shared mobile web screens. The migration adds the
smallest registers needed for leasing, without replacing existing buildings,
resident accounts, maintenance tickets, operation records or inspections.

- A company remains the existing isolated database schema; there is no second
  company, authentication or user system. Portfolios group existing buildings.
- Units belong to existing buildings. Existing resident/ticket `unit_number`
  strings remain unchanged; nullable relational links are not guessed/backfilled.
- Tenants may link to existing accounts. Their building/unit/portfolio relationships
  come through applications and lease occupancy, retaining historical moves.
- Leases support multiple occupants, one primary occupant at most, additional
  charges and renewal predecessors. Money is integer cents; escalation is basis
  points (100 basis points = 1%).
- Activated occupancy periods for a unit cannot overlap, including concurrent
  activations. Drafts neither occupy nor reserve a unit. Historical occupancy
  remains protected after termination.
- Start/end dates are inclusive. `terminated_on` is the final occupied day; a
  replacement can start the next day. Terminating before the start cancels future
  occupancy. Future activated leases reserve units.
- `leasing_lease_summary` derives Active/Expiring/Expired rather than relying on
  a nightly status update. Expiring means within 90 days. Terminated status starts
  after the final occupied day.
- `leasing_unit_occupancy` derives Vacant/Occupied/Reserved/Notice Given/Maintenance.
  Active occupancy takes precedence over manual reservations/maintenance; notice
  given applies only while occupied. An elapsed manual reservation becomes vacant.
  Use UTC database sessions consistently for date boundaries.
- Deposit receipts/refunds, reversals and requested refund statuses have separate
  records. Summary views expose paid, refunded, outstanding and held amounts.
  Paid refund requests must match an actual refund entry's lease and exact amount.
- Applications use Submitted -> Review -> Credit Check, then Approved -> Lease
  Created **or** Declined. Allowed states are stored; services will enforce transitions.
- Inspection links refer to existing shared-workspace projects and check templates;
  no second inspection-answer system is created.
- Existing maintenance tickets gain nullable tenant/lease/unit links. Existing
  meter operation records gain nullable lease/unit links; existing readings and
  consumption logic are retained.
- Renewal task/outbox tables support 90/60/30-day milestones with deduplication.
  They do not yet create tasks or send mail. Module activity records supplement
  existing authentication/authorization; they are not a separate security system.
- Foundation document rows are storage metadata; test uploads retain their bytes
  separately in `leasing_test_documents`.
  ID/passport columns are encrypted-byte storage placeholders; encryption/key
  handling must be implemented before these fields are accepted by any endpoint.

## Files and commands

- Migration: [001-leasing.sql](../server/leasing-migrations/001-leasing.sql).
- Explicit runner: [migrate-leasing.cjs](../server/migrate-leasing.cjs).
- Isolated tests: [leasing-schema.test.cjs](../server/leasing-schema.test.cjs).

Use the existing private `DATABASE_URL` configuration. Do not paste credentials
into shell history or commit them. The runner requires an explicit company scope:

```sh
# Read-only preflight; --check is the default.
node server/migrate-leasing.cjs --company CLIENT-CODE --check
node server/migrate-leasing.cjs --all-companies --check

# Only after backup, staging rehearsal and an approved maintenance window:
node server/migrate-leasing.cjs --company CLIENT-CODE --apply
# Or explicitly opt in for every currently registered company:
node server/migrate-leasing.cjs --all-companies --apply
```

Check output lists pending/already-applied status and `extensionReady`. A pending
result with `extensionReady=false` needs database-operator action before applying.
Preflight checks prerequisites/history, not execution of pending SQL; rehearsal
on a restored staging database remains necessary.

The database operator must provision `btree_gist` in `public`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
```

If already installed elsewhere, the runner refuses application. Have the database
operator review relocation and dependencies; do not drop the extension.
Client schemas keep their existing isolated search paths; the SQL explicitly
qualifies the extension's text GiST operator class.

The runner uses per-schema SHA-256/version history, a transaction-scoped advisory
lock, a 5-second lock timeout and a 60-second per-statement timeout. All clients
selected in one invocation commit together or roll back together. Repeating an
unchanged applied migration is safe; checksum changes are rejected. Never edit
an applied migration or run the raw SQL twice. Add a subsequent migration instead.
Timeouts/errors are failures, not successful partial applications.

New clients registered after an opt-in migration need the same explicit
provisioning and allowlist/feature activation before Leasing can serve them.

## Migration checklist

1. Back up the entire database, private configuration/keys, and all report/upload
   roots. Test restoring that backup before production changes.
2. Record client/schema counts and existing buildings, users, tickets, meter
   records and shared-workspace inspection counts.
3. Ensure existing application schemas are current. Required tables are
   `app_users`, `app_properties`, `maintenance_tickets`, `operation_records` and
   `check_templates`. Use a database operator with the necessary DDL privileges.
4. Provision/check the extension and run read-only preflight.
5. Rehearse on an isolated restored database, including existing application
   startup and representative read/write workflows. Run the tests below.
6. Schedule a short maintenance window: nullable column additions still acquire
   table locks. Pause writes, choose the intended client scope and explicitly apply.
7. Check migration history and repeat preflight. Compare baseline counts and
   existing text/JSON values; new links should be NULL on old records.
8. Recheck existing sign-in, client/building isolation, tickets, meter history,
   inspections and report export, plus Leasing using the approved test clients.
9. Keep real payment processing disconnected. Do not populate encrypted
   identity placeholders with plaintext; these fields have no input endpoint.

A failed application rolls back its transaction. There is intentionally no
destructive automatic down migration. If a committed migration needs reversal,
stop writes and use the rehearsed database restore/forward-fix procedure; assess
new data first rather than dropping tables or columns.

## Testing plan

```sh
# TEST_DATABASE_URL must point to a PostgreSQL operator connection that can
# create/drop disposable test databases and install btree_gist.
node --test server/leasing-schema.test.cjs
node --test server/leasing.test.cjs www/leasing-import.test.mjs
```

Without `TEST_DATABASE_URL`, database tests are explicitly skipped. The suite
creates a uniquely named disposable database and removes only that database.
No live schema is migrated.

Set `CHROMIUM` to the installed Chromium executable for the Leasing browser
subtest: real Excel worksheet selection and PDF table import, editable preview,
confirmed saving, signature canvas/version audit and 360-pixel layout.

Covered now:

- Explicit CLI scope, read-only default and rejection of conflicting flags.
- Missing extension refusal, migration application, safe repeats and checksum
  mismatch detection.
- Preservation of existing unit labels, ticket records, meter JSON and inspection
  workspace data; independent client schemas.
- Draft vacancy, activated occupancy, overlapping/concurrent activation rejection,
  sequential leases after termination, future reservations and date-derived expiry.
- Notice/maintenance states and multiple occupants with one primary at most.
- Unit/building/lease/occupant foreign-key boundaries, including applications,
  maintenance tickets and meter records.
- Deposit totals, explicit reversal reasons, paid-refund amount/lease matching,
  and renewal milestone uniqueness.
- All-company transactional rollback when a later client has conflicting objects.

Required in subsequent implementation stages:

- Backend: enforce authorization through existing feature/section/building grants;
  require a primary occupant before activation; validate account building
  assignments and inactive units; disallow invalid lifecycle transitions.
- Lock the lease row for deposit changes; prevent refunds or receipt reversals
  exceeding held funds and atomically maintain refund status/ledger entries.
  Aggregate views intentionally expose negative held balances rather than hiding
  invalid raw data; they are not a replacement for transaction validation.
- Enforce immutable history, revision checks, renewal chronology, tenant/application
  access scopes and safe date changes; audit mutations without sensitive identifiers.
- Reuse authenticated uploads with scoped download checks and verify referenced
  inspection projects exist and match their unit/building.
- Worker: deduplicate 90/60/30-day tasks, cancel superseded renewals, retry email
  safely, distinguish SMTP acceptance from delivery, and test downtime recovery.
- UI: reuse existing components/navigation, dashboard and export functions;
  test leasing widgets and report totals without changing existing modules.
- Mobile: responsive shared screens and inspection reuse first; do not claim new
  offline write support until queue/replay and cross-client isolation are tested.
