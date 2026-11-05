CREATE TABLE leasing_parking_bays (
  id UUID PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES app_properties(id),
  bay_number TEXT NOT NULL CHECK(length(btrim(bay_number)) BETWEEN 1 AND 80),
  level TEXT NOT NULL DEFAULT '' CHECK(length(level)<=80),
  bay_type TEXT NOT NULL DEFAULT '' CHECK(length(bay_type)<=100),
  unit_id TEXT,
  status TEXT NOT NULL DEFAULT '' CHECK(status IN ('','vacant','allocated','reserved','visitor','maintenance')),
  notes TEXT NOT NULL DEFAULT '' CHECK(length(notes)<=1000),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_by TEXT REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (unit_id, property_id) REFERENCES app_units(id, property_id)
);
CREATE UNIQUE INDEX leasing_parking_bays_number ON leasing_parking_bays(property_id, lower(btrim(bay_number)));
CREATE INDEX leasing_parking_bays_unit ON leasing_parking_bays(unit_id);
ALTER TABLE leasing_events ADD COLUMN parking_bay_id UUID REFERENCES leasing_parking_bays(id);
ALTER TABLE leasing_events DROP CONSTRAINT leasing_events_check,
  ADD CONSTRAINT leasing_events_refs CHECK (num_nonnulls(tenant_id, lease_id, unit_id, application_id, parking_bay_id) >= 1);
CREATE INDEX leasing_events_parking_bay ON leasing_events(parking_bay_id, id);
