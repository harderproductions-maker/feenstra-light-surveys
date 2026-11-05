ALTER TABLE leasing_leases
  ADD COLUMN occupant_count INTEGER NOT NULL DEFAULT 1 CHECK(occupant_count BETWEEN 1 AND 50),
  ADD COLUMN occupant_names TEXT NOT NULL DEFAULT '' CHECK(length(occupant_names)<=4000);
UPDATE leasing_leases l SET occupant_count=LEAST(50, GREATEST(1, (SELECT count(*) FROM leasing_lease_tenants t WHERE t.lease_id=l.id)));
