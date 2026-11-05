ALTER TABLE leasing_tenants ADD COLUMN property_id TEXT REFERENCES app_properties(id);
ALTER TABLE leasing_tenants ADD COLUMN tenant_code TEXT;
CREATE UNIQUE INDEX leasing_tenant_code ON leasing_tenants(lower(tenant_code));
ALTER TABLE leasing_leases ADD COLUMN notice_on DATE;
ALTER TABLE leasing_leases ADD COLUMN notice_reason TEXT NOT NULL DEFAULT '';
CREATE TABLE leasing_test_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  test_mode BOOLEAN NOT NULL DEFAULT TRUE CHECK(test_mode)
);
INSERT INTO leasing_test_settings(id) VALUES(1);
CREATE TABLE leasing_test_documents (
  id UUID PRIMARY KEY,
  lease_id UUID REFERENCES leasing_leases(id),
  property_id TEXT REFERENCES app_properties(id),
  is_template BOOLEAN NOT NULL DEFAULT FALSE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK(content_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  data BYTEA NOT NULL CHECK(octet_length(data) BETWEEN 1 AND 26214400),
  sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK((is_template AND lease_id IS NULL AND property_id IS NULL) OR
    (NOT is_template AND lease_id IS NOT NULL AND property_id IS NOT NULL))
);
CREATE TABLE leasing_test_signatures (
  id UUID PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES leasing_leases(id),
  document_digest TEXT NOT NULL,
  signer_id TEXT NOT NULL REFERENCES app_users(id),
  signer_name TEXT NOT NULL,
  party TEXT NOT NULL CHECK(party IN ('tenant','landlord')),
  consent TEXT NOT NULL,
  signed_snapshot JSONB NOT NULL,
  signature BYTEA NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lease_id,document_digest,party,signer_id)
);
CREATE TABLE leasing_test_ledger (
  id UUID PRIMARY KEY,
  lease_id UUID NOT NULL REFERENCES leasing_leases(id),
  kind TEXT NOT NULL CHECK(kind IN ('rent','charge','payment','credit','deposit_receipt','deposit_refund')),
  amount_cents BIGINT NOT NULL CHECK(amount_cents BETWEEN 1 AND 1000000000),
  entry_date DATE NOT NULL,
  description TEXT NOT NULL,
  service_month TEXT,
  recurring_charge_id UUID REFERENCES leasing_lease_charges(id),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX leasing_test_rent_month ON leasing_test_ledger(lease_id,service_month)
  WHERE kind='rent';
CREATE UNIQUE INDEX leasing_test_charge_month ON leasing_test_ledger(recurring_charge_id,service_month)
  WHERE recurring_charge_id IS NOT NULL;
CREATE TABLE leasing_test_schedule (
  id UUID PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES app_units(id),
  lease_id UUID REFERENCES leasing_leases(id),
  kind TEXT NOT NULL CHECK(kind IN ('move_in','vacate','inspection','renovation','maintenance')),
  title TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL CHECK(ends_on>=starts_on),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','cancelled')),
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES app_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE leasing_test_imports (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  source_name TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  source JSONB NOT NULL,
  record_ids TEXT[] NOT NULL,
  imported_by TEXT NOT NULL REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
