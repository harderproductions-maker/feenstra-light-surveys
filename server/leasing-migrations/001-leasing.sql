CREATE TABLE app_portfolios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX app_portfolios_name ON app_portfolios(lower(btrim(name)));
ALTER TABLE app_properties ADD COLUMN portfolio_id TEXT REFERENCES app_portfolios(id);
CREATE INDEX app_properties_portfolio ON app_properties(portfolio_id);

CREATE TABLE app_units (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES app_properties(id),
  unit_number TEXT NOT NULL CHECK (length(btrim(unit_number)) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  manual_state TEXT CHECK (manual_state IN ('reserved', 'notice_given', 'maintenance')),
  state_reason TEXT NOT NULL DEFAULT '' CHECK (length(state_reason) <= 2000),
  reserved_until DATE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, property_id),
  CHECK (manual_state IS NULL OR length(btrim(state_reason)) > 0),
  CHECK (reserved_until IS NULL OR (manual_state IS NOT NULL AND manual_state = 'reserved'))
);
CREATE UNIQUE INDEX app_units_number ON app_units(property_id, lower(btrim(unit_number)));

CREATE TABLE leasing_tenants (
  id UUID PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES app_users(id),
  first_name TEXT NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 100),
  last_name TEXT NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 100),
  id_number_encrypted BYTEA,
  passport_number_encrypted BYTEA,
  phone TEXT NOT NULL DEFAULT '' CHECK (length(phone) <= 40),
  email TEXT NOT NULL DEFAULT '' CHECK (length(email) <= 254),
  emergency_contact_name TEXT NOT NULL DEFAULT '' CHECK (length(emergency_contact_name) <= 160),
  emergency_contact_phone TEXT NOT NULL DEFAULT '' CHECK (length(emergency_contact_phone) <= 40),
  emergency_contact_relationship TEXT NOT NULL DEFAULT '' CHECK (length(emergency_contact_relationship) <= 100),
  employer TEXT NOT NULL DEFAULT '' CHECK (length(employer) <= 160),
  income_cents BIGINT CHECK (income_cents BETWEEN 0 AND 999999999999),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval', 'active', 'former')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX leasing_tenants_status ON leasing_tenants(status);

CREATE TABLE leasing_leases (
  id UUID PRIMARY KEY,
  lease_number TEXT NOT NULL CHECK (length(btrim(lease_number)) BETWEEN 1 AND 120),
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL CHECK (ends_on >= starts_on AND ends_on < DATE '9999-12-31'),
  monthly_rental_cents BIGINT NOT NULL CHECK (monthly_rental_cents BETWEEN 0 AND 999999999999),
  deposit_required_cents BIGINT NOT NULL DEFAULT 0 CHECK (deposit_required_cents BETWEEN 0 AND 999999999999),
  escalation_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (escalation_basis_points BETWEEN 0 AND 10000),
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 8000),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'terminated')),
  activated_at TIMESTAMPTZ,
  terminated_on DATE,
  terminated_at TIMESTAMPTZ,
  termination_reason TEXT NOT NULL DEFAULT '' CHECK (length(termination_reason) <= 2000),
  renewed_from_id UUID,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  occupied_during DATERANGE GENERATED ALWAYS AS (
    CASE WHEN state IN ('active', 'terminated') AND activated_at IS NOT NULL
      AND COALESCE(terminated_on, ends_on) >= starts_on
    THEN daterange(starts_on, LEAST(COALESCE(terminated_on, ends_on), ends_on), '[]')
    ELSE NULL END
  ) STORED,
  UNIQUE (id, unit_id),
  UNIQUE (id, unit_id, property_id),
  FOREIGN KEY (unit_id, property_id) REFERENCES app_units(id, property_id),
  FOREIGN KEY (renewed_from_id, unit_id) REFERENCES leasing_leases(id, unit_id),
  CHECK (renewed_from_id IS NULL OR renewed_from_id <> id),
  CHECK (state <> 'active' OR activated_at IS NOT NULL),
  CHECK ((state = 'terminated') = (terminated_on IS NOT NULL AND terminated_at IS NOT NULL)),
  CHECK (state = 'terminated' OR (terminated_on IS NULL AND terminated_at IS NULL)),
  CHECK (state <> 'terminated' OR (terminated_on <= ends_on AND length(btrim(termination_reason)) > 0)),
  CONSTRAINT leasing_unit_dates_no_overlap EXCLUDE USING gist (
    unit_id public.gist_text_ops WITH =,
    occupied_during WITH &&
  ) WHERE (occupied_during IS NOT NULL)
);
CREATE UNIQUE INDEX leasing_leases_number ON leasing_leases(lower(btrim(lease_number)));
CREATE INDEX leasing_leases_expiry ON leasing_leases(ends_on) WHERE state = 'active';
CREATE UNIQUE INDEX leasing_leases_renewal ON leasing_leases(renewed_from_id)
  WHERE renewed_from_id IS NOT NULL AND state <> 'terminated';

CREATE TABLE leasing_lease_tenants (
  lease_id UUID NOT NULL REFERENCES leasing_leases(id),
  tenant_id UUID NOT NULL REFERENCES leasing_tenants(id),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  moved_in_on DATE,
  moved_out_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lease_id, tenant_id),
  CHECK (moved_out_on IS NULL OR (moved_in_on IS NOT NULL AND moved_out_on >= moved_in_on))
);
CREATE UNIQUE INDEX leasing_primary_tenant ON leasing_lease_tenants(lease_id) WHERE is_primary;
CREATE INDEX leasing_tenant_leases ON leasing_lease_tenants(tenant_id);

CREATE TABLE leasing_lease_charges (
  id UUID PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES leasing_leases(id),
  description TEXT NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 1 AND 999999999999),
  frequency TEXT NOT NULL CHECK (frequency IN ('once_off', 'monthly')),
  starts_on DATE,
  ends_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_on IS NULL OR (starts_on IS NOT NULL AND ends_on >= starts_on))
);
CREATE INDEX leasing_charges_lease ON leasing_lease_charges(lease_id);

CREATE TABLE leasing_applications (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES leasing_tenants(id),
  property_id TEXT NOT NULL REFERENCES app_properties(id),
  unit_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'review', 'credit_check', 'approved', 'declined', 'lease_created')),
  credit_check_result TEXT NOT NULL DEFAULT '' CHECK (length(credit_check_result) <= 2000),
  review_notes TEXT NOT NULL DEFAULT '' CHECK (length(review_notes) <= 4000),
  lease_id UUID REFERENCES leasing_leases(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (unit_id, property_id) REFERENCES app_units(id, property_id),
  FOREIGN KEY (lease_id, unit_id, property_id) REFERENCES leasing_leases(id, unit_id, property_id),
  FOREIGN KEY (lease_id, tenant_id) REFERENCES leasing_lease_tenants(lease_id, tenant_id),
  CHECK ((status = 'lease_created') = (lease_id IS NOT NULL)),
  CHECK (lease_id IS NULL OR unit_id IS NOT NULL)
);
CREATE INDEX leasing_applications_building ON leasing_applications(property_id, status);
CREATE INDEX leasing_applications_tenant ON leasing_applications(tenant_id);

CREATE TABLE leasing_deposit_entries (
  id UUID PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES leasing_leases(id),
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'refund')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 1 AND 999999999999),
  reference TEXT NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  paid_on DATE NOT NULL,
  notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided_at TIMESTAMPTZ,
  voided_by TEXT REFERENCES app_users(id),
  void_reason TEXT CHECK (length(void_reason) <= 2000),
  UNIQUE (id, lease_id, kind, amount_cents),
  CHECK ((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0))
);
CREATE UNIQUE INDEX leasing_deposit_reference ON leasing_deposit_entries(lease_id, lower(btrim(reference)));

CREATE TABLE leasing_deposit_refunds (
  id UUID PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES leasing_leases(id),
  amount_cents BIGINT NOT NULL CHECK (amount_cents BETWEEN 1 AND 999999999999),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'declined', 'paid', 'cancelled')),
  reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  payment_entry_id UUID UNIQUE,
  payment_entry_kind TEXT GENERATED ALWAYS AS (CASE WHEN payment_entry_id IS NOT NULL THEN 'refund' END) STORED,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (payment_entry_id, lease_id, payment_entry_kind, amount_cents)
    REFERENCES leasing_deposit_entries(id, lease_id, kind, amount_cents),
  CHECK ((status = 'paid') = (payment_entry_id IS NOT NULL))
);
CREATE INDEX leasing_deposit_refunds_lease ON leasing_deposit_refunds(lease_id, status);

CREATE TABLE leasing_documents (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES leasing_tenants(id),
  application_id UUID REFERENCES leasing_applications(id),
  lease_id UUID REFERENCES leasing_leases(id),
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 240),
  original_name TEXT NOT NULL CHECK (length(original_name) BETWEEN 1 AND 240),
  content_type TEXT NOT NULL CHECK (length(content_type) BETWEEN 1 AND 160),
  size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(tenant_id, application_id, lease_id) = 1)
);
CREATE INDEX leasing_documents_tenant ON leasing_documents(tenant_id);
CREATE INDEX leasing_documents_application ON leasing_documents(application_id);
CREATE INDEX leasing_documents_lease ON leasing_documents(lease_id);

CREATE TABLE leasing_inspection_links (
  id UUID PRIMARY KEY,
  lease_id UUID NOT NULL,
  property_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('move_in', 'move_out')),
  workspace_project_id TEXT NOT NULL CHECK (length(workspace_project_id) BETWEEN 1 AND 120),
  template_id TEXT REFERENCES check_templates(id),
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (lease_id, unit_id, property_id) REFERENCES leasing_leases(id, unit_id, property_id),
  UNIQUE (workspace_project_id)
);
CREATE INDEX leasing_inspections_lease ON leasing_inspection_links(lease_id, kind);

CREATE TABLE leasing_renewal_tasks (
  id UUID PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES leasing_leases(id),
  lease_revision INTEGER NOT NULL CHECK (lease_revision > 0),
  days_before INTEGER NOT NULL CHECK (days_before IN (90, 60, 30)),
  due_on DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  assigned_to TEXT REFERENCES app_users(id),
  completed_by TEXT REFERENCES app_users(id),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lease_id, lease_revision, days_before),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CHECK (status = 'completed' OR (completed_at IS NULL AND completed_by IS NULL))
);
CREATE INDEX leasing_renewal_due ON leasing_renewal_tasks(due_on) WHERE status = 'pending';

CREATE TABLE leasing_notification_outbox (
  id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES leasing_renewal_tasks(id),
  recipient_user_id TEXT NOT NULL REFERENCES app_users(id),
  recipient_email TEXT NOT NULL DEFAULT '' CHECK (length(recipient_email) <= 254),
  read_at TIMESTAMPTZ,
  email_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (email_status IN ('pending', 'sending', 'accepted', 'failed', 'not_configured', 'cancelled')),
  email_attempts INTEGER NOT NULL DEFAULT 0 CHECK (email_attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  email_error TEXT CHECK (length(email_error) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (task_id, recipient_user_id)
);
CREATE INDEX leasing_email_pending ON leasing_notification_outbox(next_attempt_at)
  WHERE email_status IN ('pending', 'failed', 'sending');

CREATE TABLE leasing_events (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID REFERENCES leasing_tenants(id),
  lease_id UUID REFERENCES leasing_leases(id),
  unit_id TEXT REFERENCES app_units(id),
  application_id UUID REFERENCES leasing_applications(id),
  actor_id TEXT REFERENCES app_users(id),
  actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'system')),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (num_nonnulls(tenant_id, lease_id, unit_id, application_id) >= 1),
  CHECK (actor_kind <> 'user' OR actor_id IS NOT NULL)
);
CREATE INDEX leasing_events_lease ON leasing_events(lease_id, id);
CREATE INDEX leasing_events_tenant ON leasing_events(tenant_id, id);
CREATE INDEX leasing_events_unit ON leasing_events(unit_id, id);
CREATE INDEX leasing_events_application ON leasing_events(application_id, id);

ALTER TABLE maintenance_tickets ADD COLUMN leasing_unit_id TEXT;
ALTER TABLE maintenance_tickets ADD COLUMN leasing_lease_id UUID;
ALTER TABLE maintenance_tickets ADD COLUMN leasing_tenant_id UUID REFERENCES leasing_tenants(id);
ALTER TABLE maintenance_tickets ADD CONSTRAINT maintenance_tickets_leasing_unit
  FOREIGN KEY (leasing_unit_id, property_id) REFERENCES app_units(id, property_id);
ALTER TABLE maintenance_tickets ADD CONSTRAINT maintenance_tickets_leasing_lease
  FOREIGN KEY (leasing_lease_id, leasing_unit_id, property_id) REFERENCES leasing_leases(id, unit_id, property_id);
ALTER TABLE maintenance_tickets ADD CONSTRAINT maintenance_tickets_leasing_occupant
  FOREIGN KEY (leasing_lease_id, leasing_tenant_id) REFERENCES leasing_lease_tenants(lease_id, tenant_id);
ALTER TABLE maintenance_tickets ADD CONSTRAINT maintenance_tickets_leasing_links
  CHECK ((leasing_lease_id IS NULL OR leasing_unit_id IS NOT NULL)
    AND (leasing_tenant_id IS NULL OR leasing_lease_id IS NOT NULL));
CREATE INDEX maintenance_tickets_leasing_tenant ON maintenance_tickets(leasing_tenant_id, created_at);
CREATE INDEX maintenance_tickets_leasing_lease ON maintenance_tickets(leasing_lease_id);

ALTER TABLE operation_records ADD COLUMN leasing_unit_id TEXT;
ALTER TABLE operation_records ADD COLUMN leasing_lease_id UUID;
ALTER TABLE operation_records ADD CONSTRAINT operation_records_leasing_unit
  FOREIGN KEY (leasing_unit_id, property_id) REFERENCES app_units(id, property_id);
ALTER TABLE operation_records ADD CONSTRAINT operation_records_leasing_lease
  FOREIGN KEY (leasing_lease_id, leasing_unit_id, property_id) REFERENCES leasing_leases(id, unit_id, property_id);
ALTER TABLE operation_records ADD CONSTRAINT operation_records_leasing_links
  CHECK (leasing_lease_id IS NULL OR leasing_unit_id IS NOT NULL);
CREATE INDEX operation_records_leasing_unit ON operation_records(leasing_unit_id, kind);

CREATE VIEW leasing_lease_summary AS
SELECT l.*,
  CASE WHEN l.state = 'draft' THEN 'draft'
    WHEN l.state = 'terminated' AND l.terminated_on < CURRENT_DATE THEN 'terminated'
    WHEN l.ends_on < CURRENT_DATE THEN 'expired'
    WHEN l.ends_on <= CURRENT_DATE + 90 THEN 'expiring'
    ELSE 'active' END AS status
FROM leasing_leases l;

CREATE VIEW leasing_unit_occupancy AS
SELECT u.*,
  CASE WHEN EXISTS (
    SELECT 1 FROM leasing_leases l
    WHERE l.unit_id = u.id AND l.occupied_during @> CURRENT_DATE
  ) THEN CASE WHEN u.manual_state = 'notice_given' THEN 'notice_given' ELSE 'occupied' END
  WHEN u.manual_state = 'maintenance' THEN 'maintenance'
  WHEN (u.manual_state = 'reserved' AND (u.reserved_until IS NULL OR u.reserved_until >= CURRENT_DATE))
    OR EXISTS (SELECT 1 FROM leasing_leases l WHERE l.unit_id = u.id AND l.state = 'active' AND l.starts_on > CURRENT_DATE)
    THEN 'reserved'
  ELSE 'vacant' END AS occupancy_state
FROM app_units u;

CREATE VIEW leasing_deposit_summary AS
SELECT l.id AS lease_id, l.property_id, l.unit_id, l.deposit_required_cents,
  COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind = 'receipt' AND e.voided_at IS NULL), 0)::BIGINT AS paid_cents,
  COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind = 'refund' AND e.voided_at IS NULL), 0)::BIGINT AS refunded_cents,
  GREATEST(l.deposit_required_cents - COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind = 'receipt' AND e.voided_at IS NULL), 0), 0)::BIGINT AS outstanding_cents,
  (COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind = 'receipt' AND e.voided_at IS NULL), 0)
    - COALESCE(SUM(e.amount_cents) FILTER (WHERE e.kind = 'refund' AND e.voided_at IS NULL), 0))::BIGINT AS held_cents
FROM leasing_leases l LEFT JOIN leasing_deposit_entries e ON e.lease_id = l.id GROUP BY l.id;
