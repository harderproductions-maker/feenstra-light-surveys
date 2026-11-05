# PrimeOps — Product experience and leasing implementation plan

Status: implementation specification, not completed functionality.
Branch: `primeops/product-experience-and-leasing`. Base: PrimeOps compatibility-first rebrand. Do not merge without validation.

## Non-negotiables
- PrimeOps is an independent product. No employer-specific branding.
- Preserve working lighting surveys, building checks, offline data, imports, reports and existing user access.
- Preserve existing storage identifiers, database records, tokens and compatible exports until explicit migrations are tested.
- Separate company/client tenancy and permission boundaries before expanding owner/client administration.
- Never silently change the legal wording of imported documents. Keep originals and track versions.
- Test on Windows, Android and narrow screens before release.

## Phase 1 — Navigation and information architecture
- Replace dense content-first pages with a responsive, accessible app shell.
- Primary destinations: Overview, Properties, Inspections, Maintenance, Leasing, Documents, People, Reports, Settings.
- Hide inaccessible destinations by role; enforce access server-side too.
- Use clickable tabs inside detail pages (Overview, Units, Occupants, Documents, Activity).
- Show summaries first, details on demand, contextual primary actions, breadcrumbs, search and filters.
- Preserve current survey/check workflow and existing view routing during rollout.
- Test keyboard navigation, mobile touch targets, empty/error/loading states and offline indicators.

## Phase 2 — Identity and profile management
- Roles: platform owner, company administrator, property manager, staff, tenant/occupant; explicitly model company-scoped permissions.
- Editable profile fields with validation, uniqueness, authorization and change audit.
- Invite users, suspend/reactivate accounts, reassign property access, secure password reset/change.
- Never display existing passwords or allow arbitrary admin password retrieval.
- Test cross-company isolation, authorization, session revocation and credential flows.

## Phase 3 — Lease builder
- Structured lease model: company, property, unit, leaseholder(s), occupants, contact details, term, rent, deposit, escalation, utilities, clauses, documents, signatures, statuses and amendments.
- Create from blank guided wizard, approved company template, or imported document.
- Add/remove/edit multiple occupants independently of leaseholder; distinguish occupant from financially responsible signatory.
- Draft, review, approval, signature and renewal workflow; keep revision history.
- Validate mandatory fields and relationships before finalization; no destructive overwrites.

## Phase 4 — Document import and reconstruction
- Accept PDF, DOCX and supported scanned images with safe file size/type limits and malware checks.
- Extract text and layout using native parsers; OCR for scanned content.
- Preserve original bytes, document metadata, page ordering and version history.
- Detect fields, clauses, checkboxes, tables and signature positions; generate editable structured representations.
- Preview original alongside digital version with field confidence and explicit correction/confirmation.
- Never auto-invent missing clauses, silently substitute text, or imply legal validity solely from OCR.
- Save reviewed reusable company templates for leases, inspections and maintenance checklists.
- Handle low-quality scans, password-protected files, mixed-language documents and extraction failures with clear errors.
- Data retention, access control, encryption and applicable South African privacy/legal review before production.

## Delivery and acceptance gates
1. Audit current views, routes, database schema, APIs and user flows.
2. Implement smallest isolated navigation improvement, add regression checks.
3. Add profile editing API and UI with server-side authorization tests.
4. Implement lease schema and guided create/edit with occupant support.
5. Implement import pipeline, review UI and reusable templates.
6. Run syntax/build checks, automated functional tests and manual Android/Windows acceptance.
7. Keep each change in a reviewable PR; do not merge unverified work.

## Known existing implementation constraints to investigate
- Existing `www/app.js` uses a central `currentView` and dynamic workspace rendering.
- Existing `www/index.html` has a sidebar and account dialog but no full profile editor.
- Existing `server/index.cjs` authenticates users and checks admin role, but company-scoped roles require new modelling.
- Existing storage and sync design must be reviewed before adding leases or private documents.
